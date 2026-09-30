import {
	DriftClient,
	PerpMarketAccount,
	SpotMarketAccount,
	SlotSubscriber,
	NodeToTrigger,
	UserMap,
	MarketType,
	DLOBSubscriber,
	PublicKey,
	BlockhashSubscriber,
	ClockSubscriber,
	PriorityFeeSubscriber,
	isVariant,
	getVariant,
	SpotMarketConfig,
	PerpMarketConfig,
	MainnetSpotMarkets,
	DevnetSpotMarkets,
	MainnetPerpMarkets,
	DevnetPerpMarkets,
	convertToNumber,
	BN,
	convertToBN,
	PRICE_PRECISION,
	getTriggerPrice,
	useMedianTriggerPrice,
	PythLazerPriceFeedArray,
	PythLazerSubscriber,
} from '@velocity-exchange/sdk';
import { Mutex, tryAcquire, E_ALREADY_LOCKED } from 'async-mutex';

import { logger } from '../logger';
import { Bot } from '../types';
import { getErrorCode } from '../error';
import { webhookMessage } from '../webhook';
import { GlobalConfig, TriggerConfig } from '../config';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { Counter, Histogram, Meter, ObservableGauge } from '@opentelemetry/api';
import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	MeterProvider,
	View,
} from '@opentelemetry/sdk-metrics-base';
import { RuntimeSpec, metricAttrFromUserAccount } from '../metrics';
import {
	chunks,
	getNodeToTriggerSignature,
	simulateAndGetTxWithCUs,
} from '../utils';
import {
	AddressLookupTableAccount,
	ComputeBudgetProgram,
	TransactionInstruction,
} from '@solana/web3.js';

const TRIGGER_ORDER_COOLDOWN_MS = 10000; // time to wait between triggering an order

const errorCodesToSuppress = [
	6111, // Error Message: OrderNotTriggerable.
	6112, // Error Message: OrderDidNotSatisfyTriggerCondition.
];

enum METRIC_TYPES {
	sdk_call_duration_histogram = 'sdk_call_duration_histogram',
	try_trigger_duration_histogram = 'try_trigger_duration_histogram',
	runtime_specs = 'runtime_specs',
	mutex_busy = 'mutex_busy',
	errors = 'errors',
	trigger_attempts = 'trigger_attempts',
}

function getPythLazerFeedIdChunks(
	spotMarkets: SpotMarketConfig[],
	perpMarkets: PerpMarketConfig[],
	chunkSize = 11
): PythLazerPriceFeedArray[] {
	const allFeedIds: number[] = [];
	for (const market of [...spotMarkets, ...perpMarkets]) {
		if (
			!getVariant(market.oracleSource).toLowerCase().includes('lazer') ||
			market.pythLazerId == undefined
		) {
			continue;
		}
		allFeedIds.push(market.pythLazerId!);
	}

	const allFeedIdsSet = new Set(allFeedIds);
	return chunks(Array.from(allFeedIdsSet), chunkSize).map((ids) => {
		return {
			priceFeedIds: ids,
			channel: 'fixed_rate@200ms',
		};
	});
}

export class TriggerBot implements Bot {
	public readonly name: string;
	public readonly dryRun: boolean;
	public readonly defaultIntervalMs: number = 1000;

	private driftClient: DriftClient;
	private slotSubscriber: SlotSubscriber;
	private clockSubscriber!: ClockSubscriber;
	private globalConfig: GlobalConfig;
	private triggerConfig: TriggerConfig;
	private dlobSubscriber?: DLOBSubscriber;
	private blockhashSubscriber: BlockhashSubscriber;
	private lookupTableAccounts?: AddressLookupTableAccount[];
	private triggeringNodes = new Map<string, number>();
	// Fire-phase outcome keys (user-account PDA + orderId signature) carried
	// across the fire→ratchet phase boundary (TS-S3-10/TS-S3-11). Cleared after
	// each sweep.
	private successfulFireKeys = new Set<string>();
	private periodicTaskMutex = new Mutex();
	private intervalIds: Array<NodeJS.Timer> = [];
	private userMap: UserMap;

	private priorityFeeSubscriber: PriorityFeeSubscriber;

	// metrics
	private metricsInitialized = false;
	private metricsPort?: number;
	private exporter?: PrometheusExporter;
	private meter?: Meter;
	private bootTimeMs = Date.now();
	private runtimeSpecsGauge?: ObservableGauge;
	private runtimeSpec: RuntimeSpec;
	private mutexBusyCounter?: Counter;
	private errorCounter?: Counter;
	private triggerCounter?: Counter;
	private tryTriggerDurationHistogram?: Histogram;

	private watchdogTimerMutex = new Mutex();
	private watchdogTimerLastPatTime = Date.now();

	private updateOracleWithTrigger: boolean = false;

	private pythLazerClient?: PythLazerSubscriber;

	// map from marketId (i.e. perp-0 or spot-0) to multiplier (1, 10, 1000, etc.)
	private marketIdToMultiplier: Map<string, number> = new Map();

	constructor(
		driftClient: DriftClient,
		slotSubscriber: SlotSubscriber,
		blockhashSubscriber: BlockhashSubscriber,
		userMap: UserMap,
		runtimeSpec: RuntimeSpec,
		config: TriggerConfig,
		globalConfig: GlobalConfig,
		priorityFeeSubscriber: PriorityFeeSubscriber
	) {
		this.name = config.botId;
		this.dryRun = config.dryRun;
		this.triggerConfig = config;
		this.globalConfig = globalConfig;
		this.driftClient = driftClient;
		this.userMap = userMap;
		this.runtimeSpec = runtimeSpec;
		this.slotSubscriber = slotSubscriber;
		this.blockhashSubscriber = blockhashSubscriber;

		this.metricsPort = config.metricsPort;
		if (this.metricsPort) {
			this.initializeMetrics();
		}
		this.priorityFeeSubscriber = priorityFeeSubscriber;
		this.priorityFeeSubscriber.updateAddresses([
			new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'), // Openbook SOL/USDC
			new PublicKey('8UJgxaiQx5nTrdDgph5FiahMmzduuLTLf5WmsPegYA6W'), // sol-perp
		]);

		if (this.globalConfig.lazerEndpoints && this.globalConfig.lazerToken) {
			logger.info('Updating pyth oracles with trigger');
			this.updateOracleWithTrigger = true;

			const spotMarkets =
				this.globalConfig.driftEnv === 'mainnet-beta'
					? MainnetSpotMarkets
					: DevnetSpotMarkets;
			const perpMarkets =
				this.globalConfig.driftEnv === 'mainnet-beta'
					? MainnetPerpMarkets
					: DevnetPerpMarkets;
			this.pythLazerClient = new PythLazerSubscriber(
				this.globalConfig.lazerEndpoints,
				this.globalConfig.lazerToken,
				getPythLazerFeedIdChunks(spotMarkets, perpMarkets, 1),
				this.globalConfig.driftEnv
			);

			for (const market of [...spotMarkets, ...perpMarkets]) {
				const oracleSource = getVariant(market.oracleSource);
				if (!oracleSource.toLowerCase().includes('lazer')) {
					continue;
				}
				const isSpotMarket = 'precision' in market;
				const marketId = isSpotMarket
					? `spot-${market.marketIndex}`
					: `perp-${market.marketIndex}`;
				if (oracleSource.toLowerCase().includes('1k')) {
					this.marketIdToMultiplier.set(marketId, 1000);
				} else if (oracleSource.toLowerCase().includes('1m')) {
					this.marketIdToMultiplier.set(marketId, 1000000);
				} else {
					this.marketIdToMultiplier.set(marketId, 1);
				}
			}
		} else {
			logger.info(
				'Not updating pyth oracles with trigger (globalConfig missing lazerEndpoints or lazerToken)'
			);
		}
	}

	private initializeMetrics() {
		if (this.metricsInitialized) {
			logger.error('Tried to initilaize metrics multiple times');
			return;
		}
		this.metricsInitialized = true;

		const { endpoint: defaultEndpoint } = PrometheusExporter.DEFAULT_OPTIONS;
		this.exporter = new PrometheusExporter(
			{
				port: this.metricsPort,
				endpoint: defaultEndpoint,
			},
			() => {
				logger.info(
					`prometheus scrape endpoint started: http://localhost:${this.metricsPort}${defaultEndpoint}`
				);
			}
		);
		const meterName = this.name;
		const meterProvider = new MeterProvider({
			views: [
				new View({
					instrumentName: METRIC_TYPES.try_trigger_duration_histogram,
					instrumentType: InstrumentType.HISTOGRAM,
					meterName: meterName,
					aggregation: new ExplicitBucketHistogramAggregation(
						Array.from(new Array(20), (_, i) => 0 + i * 5),
						true
					),
				}),
			],
		});

		meterProvider.addMetricReader(this.exporter);
		this.meter = meterProvider.getMeter(meterName);

		this.bootTimeMs = Date.now();

		this.runtimeSpecsGauge = this.meter.createObservableGauge(
			METRIC_TYPES.runtime_specs,
			{
				description: 'Runtime sepcification of this program',
			}
		);
		this.runtimeSpecsGauge.addCallback((obs) => {
			obs.observe(this.bootTimeMs, this.runtimeSpec);
		});
		this.mutexBusyCounter = this.meter.createCounter(METRIC_TYPES.mutex_busy, {
			description: 'Count of times the mutex was busy',
		});
		this.errorCounter = this.meter.createCounter(METRIC_TYPES.errors, {
			description: 'Count of errors',
		});
		this.triggerCounter = this.meter.createCounter(
			METRIC_TYPES.trigger_attempts,
			{
				description: 'Count of trigger attempts',
			}
		);
		this.tryTriggerDurationHistogram = this.meter.createHistogram(
			METRIC_TYPES.try_trigger_duration_histogram,
			{
				description: 'Distribution of tryTrigger',
				unit: 'ms',
			}
		);
	}

	public async init() {
		logger.info(
			`${this.name} initing (trigger cu boost: ${this.triggerConfig.triggerPriorityFeeMultiplier})`
		);

		this.dlobSubscriber = new DLOBSubscriber({
			dlobSource: this.userMap,
			slotSource: this.slotSubscriber,
			updateFrequency: this.defaultIntervalMs - 500,
			driftClient: this.driftClient,
		});
		await this.dlobSubscriber.subscribe();

		this.clockSubscriber = new ClockSubscriber(this.driftClient.connection, {
			commitment: 'finalized',
			resubTimeoutMs: 5_000,
		});
		await this.clockSubscriber.subscribe();

		this.lookupTableAccounts =
			await this.driftClient.fetchAllLookupTableAccounts();

		if (this.updateOracleWithTrigger && this.pythLazerClient) {
			await this.pythLazerClient.subscribe();
		}
	}

	public async reset() {
		for (const intervalId of this.intervalIds) {
			clearInterval(intervalId as NodeJS.Timeout);
		}
		this.intervalIds = [];

		await this.dlobSubscriber!.unsubscribe();
		await this.clockSubscriber!.unsubscribe();
		await this.userMap!.unsubscribe();
	}

	public async startIntervalLoop(intervalMs?: number): Promise<void> {
		this.tryTrigger();
		const intervalId = setInterval(this.tryTrigger.bind(this), intervalMs);
		this.intervalIds.push(intervalId);

		logger.info(`${this.name} Bot started!`);
	}

	public async healthCheck(): Promise<boolean> {
		let healthy = false;
		await this.watchdogTimerMutex.runExclusive(async () => {
			healthy =
				this.watchdogTimerLastPatTime > Date.now() - 2 * this.defaultIntervalMs;
		});

		return healthy;
	}

	private async getBlockhashForTx(): Promise<string> {
		const cachedBlockhash = this.blockhashSubscriber.getLatestBlockhash(10);
		if (cachedBlockhash) {
			return cachedBlockhash.blockhash as string;
		}

		const recentBlockhash =
			await this.driftClient.connection.getLatestBlockhash({
				commitment: 'confirmed',
			});

		return recentBlockhash.blockhash;
	}

	private getOffChainOraclePrice(
		marketType: MarketType,
		marketIndex: number
	): BN | undefined {
		if (!this.updateOracleWithTrigger) return undefined;

		// TODO: support spot markets, need to also update pythLazerSubscriber
		if (isVariant(marketType, 'spot')) {
			return undefined;
		}
		const marketId = `perp-${marketIndex}`;
		const multiplier = this.marketIdToMultiplier.get(marketId);
		if (multiplier === undefined) {
			return undefined;
		}
		const price = this.pythLazerClient?.getPriceFromMarketIndex(marketIndex);
		if (!price) {
			logger.warn(`No price for market ${marketId}`);
			return undefined;
		}
		return convertToBN(price * multiplier, PRICE_PRECISION);
	}

	private async getOracleUpdateIxs(
		marketType: MarketType,
		marketIndex: number,
		ixs: TransactionInstruction[]
	): Promise<TransactionInstruction[]> {
		if (!this.updateOracleWithTrigger) return [];

		// TODO: support spot markets, need to also update pythLazerSubscriber
		if (isVariant(marketType, 'spot')) {
			return [];
		}
		const marketId = `perp-${marketIndex}`;
		if (!this.marketIdToMultiplier.has(marketId)) {
			return [];
		}

		const msg = await this.pythLazerClient?.getLatestPriceMessageForMarketIndex(
			marketIndex
		);
		if (!msg) {
			return [];
		}
		const feedIds =
			this.pythLazerClient?.getPriceFeedIdsFromMarketIndex(marketIndex);
		if (!feedIds) {
			return [];
		}
		ixs.push(
			...(await this.driftClient.getPostPythLazerOracleUpdateIxs(
				feedIds,
				msg,
				ixs
			))
		);

		return ixs;
	}

	private async tryTriggerForMarket(
		market: PerpMarketAccount | SpotMarketAccount,
		marketType: MarketType
	) {
		const marketIndex = market.marketIndex;
		const marketTypeStr = getVariant(marketType);

		try {
			const oraclePriceData = isVariant(marketType, 'perp')
				? this.driftClient.getOracleDataForPerpMarket(marketIndex)
				: this.driftClient.getOracleDataForSpotMarket(marketIndex);

			const offChainPrice = this.getOffChainOraclePrice(
				marketType,
				marketIndex
			);

			const freshestOraclePrice = offChainPrice
				? offChainPrice
				: oraclePriceData.price;
			let triggerPrice = freshestOraclePrice;

			if (isVariant(marketType, 'spot')) {
				// TS-SPOT-1: spot fire-1 discovery uses positive raw-oracle
				// semantics (mirror on-chain unsigned_abs); skip non-positive.
				triggerPrice = triggerPrice.abs();
				if (triggerPrice.isZero()) {
					logger.warn(
						`skipping spot fire-1 sweep for market ${marketIndex}: non-positive oracle price`
					);
					return;
				}
			}

			if (isVariant(marketType, 'perp')) {
				triggerPrice = getTriggerPrice(
					market as PerpMarketAccount,
					freshestOraclePrice,
					new BN(Date.now() / 1000),
					useMedianTriggerPrice(this.driftClient.getStateAccount())
				);
			}

			// Last-price source for Last trigger orders (perp: PerpMarket.lastFillPrice;
			// spot: SpotMarket.lastFillPrice, base markets only; DLOB skips
			// Last nodes when null/zero and never oracle-fallbacks).
			const lastTriggerPrice = isVariant(marketType, 'perp')
				? (market as PerpMarketAccount).lastFillPrice ?? null
				: (market as SpotMarketAccount).lastFillPrice ?? null;

			const dlob = this.dlobSubscriber!.getDLOB();
			const nodesToTrigger = dlob.findNodesToTrigger(
				marketIndex,
				this.slotSubscriber.getSlot(),
				triggerPrice,
				marketType,
				this.driftClient.getStateAccount(),
				lastTriggerPrice
			);

			// Also check queue triggers (TriggerLimit+Queue / TriggerAbsorb)
			const queueNodesToTrigger = dlob.findQueueNodesToTrigger(
				marketIndex,
				this.slotSubscriber.getSlot(),
				triggerPrice,
				marketType,
				this.driftClient.getStateAccount(),
				lastTriggerPrice
			);

			const allNodesToTrigger = [...nodesToTrigger, ...queueNodesToTrigger];

			const pendingSends: Array<Promise<unknown>> = [];
			for (const nodeToTrigger of allNodesToTrigger) {
				const now = Date.now();
				const nodeToFillSignature = getNodeToTriggerSignature(nodeToTrigger);
				const timeStartedToTriggerNode =
					this.triggeringNodes.get(nodeToFillSignature);
				if (timeStartedToTriggerNode) {
					if (timeStartedToTriggerNode + TRIGGER_ORDER_COOLDOWN_MS > now) {
						logger.warn(
							`triggering node ${nodeToFillSignature} too soon (${
								now - timeStartedToTriggerNode
							}ms since last trigger), skipping`
						);
						continue;
					}
				}

				if (nodeToTrigger.node.haveTrigger) {
					continue;
				}
				nodeToTrigger.node.haveTrigger = true;

				this.triggeringNodes.set(nodeToFillSignature, Date.now());

				try {
					logger.info(
						`trying to trigger ${marketTypeStr} order on market ${
							nodeToTrigger.node.order.marketIndex
						}. user: ${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}. oracleUpdate: ${
							this.updateOracleWithTrigger
						}. OnChainPrice: ${convertToNumber(
							oraclePriceData.price
						)}. OffChainPrice: ${
							offChainPrice ? convertToNumber(offChainPrice) : 'N/A'
						}`
					);

					const user = await this.userMap!.mustGet(
						nodeToTrigger.node.userAccount.toString()
					);

					let cuUnits = 100_000; // base case
					const activePositions =
						user.getActivePerpPositions().length +
						user.getActiveSpotPositions().length;
					const openOrders = user.getUserAccount().openOrders;
					cuUnits += activePositions * 15_000;
					cuUnits += openOrders * 5_000;

					let ixs = [
						ComputeBudgetProgram.setComputeUnitLimit({
							units: cuUnits,
						}),
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: Math.floor(
								this.priorityFeeSubscriber.getCustomStrategyResult() *
									this.driftClient.txSender.getSuggestedPriorityFeeMultiplier() *
									(this.triggerConfig.triggerPriorityFeeMultiplier ?? 1.0)
							),
						}),
					];
					if (offChainPrice) {
						ixs = await this.getOracleUpdateIxs(marketType, marketIndex, ixs);
					}
					ixs.push(
						await this.driftClient.getTriggerOrderIx(
							new PublicKey(nodeToTrigger.node.userAccount),
							user.getUserAccount(),
							nodeToTrigger.node.order
						)
					);

					ixs.push(await this.driftClient.getRevertFillIx());

					// const tx = getVersionedTransaction(
					// 	this.driftClient.wallet.publicKey,
					// 	ixs,
					// 	this.lookupTableAccounts!,
					// 	await this.getBlockhashForTx()
					// );

					const resp = await simulateAndGetTxWithCUs({
						ixs,
						connection: this.driftClient.connection,
						payerPublicKey: this.driftClient.wallet.publicKey,
						lookupTableAccounts: this.lookupTableAccounts!,
						cuLimitMultiplier: 1.2,
						doSimulation: true,
						dumpTx: false,
						recentBlockhash: this.blockhashSubscriber.getLatestBlockhash(
							1 + Math.floor(Math.random() * 10)
						)!.blockhash as string,
					});

					if (resp.simError) {
						logger.error(
							`Error (${JSON.stringify(
								resp.simError
							)}) triggering ${marketTypeStr} order for user ${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}`
						);
						continue;
					} else {
						if (this.dryRun) {
							logger.info(
								`[DRY RUN] Would trigger ${marketTypeStr} order for user ${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}`
							);
						} else {
							pendingSends.push(
								this.driftClient
									.sendTransaction(resp.tx)
									.then((txSig) => {
										nodeToTrigger.node.haveTrigger = false;
										this.triggerCounter!.add(1, {
											marketType: marketTypeStr,
											auth: this.driftClient.wallet.publicKey.toString(),
										});
										logger.info(
											`Triggered ${marketTypeStr}. user: ${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}: ${
												txSig.txSig
											}, cuUnits: ${cuUnits}, activePositions: ${activePositions}, openOrders: ${openOrders}`
										);
									})
									.catch((error) => {
										nodeToTrigger.node.haveTrigger = false;

										const errorCode = getErrorCode(error);
										if (
											errorCode &&
											!errorCodesToSuppress.includes(errorCode) &&
											!(error as Error).message.includes(
												'Transaction was not confirmed'
											)
										) {
											if (errorCode) {
												this.errorCounter!.add(1, {
													errorCode: errorCode.toString(),
												});
											}
											logger.error(
												`Error (${errorCode}) triggering ${marketTypeStr} order for user ${nodeToTrigger.node.userAccount.toString()}-${nodeToTrigger.node.order.orderId.toString()}`
											);
											logger.error(error);
											webhookMessage(
												`[${
													this.name
												}]: :x: Error (${errorCode}) triggering ${marketTypeStr} order for user (account: ${nodeToTrigger.node.userAccount.toString()}) ${marketTypeStr} order: ${nodeToTrigger.node.order.orderId.toString()}\n${
													error.stack ? error.stack : error.message
												}`
											);
										}
									})
									.finally(() => {
										this.removeTriggeringNodes([nodeToTrigger]);
									})
							);
						}
					}
				} finally {
					// Per-node cleanup on EVERY path (CODE-1): sim/dry-run
					// branches and sync exceptions escape straight here.
					nodeToTrigger.node.haveTrigger = false;
					this.removeTriggeringNodes([nodeToTrigger]);
				}
			}
			await Promise.allSettled(pendingSends);
		} catch (e) {
			logger.error(
				`Unexpected error for ${marketTypeStr} market ${marketIndex.toString()} during triggers`
			);
			console.error(e);
			if (e instanceof Error) {
				webhookMessage(
					`[${this.name}]: :x: Uncaught error:\n${
						e.stack ? e.stack : e.message
					}`
				);
			}
		}
	}

	private async tryFireTrailingForMarket(
		market: PerpMarketAccount | SpotMarketAccount,
		marketType: MarketType
	) {
		const marketIndex = market.marketIndex;
		const marketTypeStr = getVariant(marketType);

		try {
			const oraclePriceData = isVariant(marketType, 'perp')
				? this.driftClient.getOracleDataForPerpMarket(marketIndex)
				: this.driftClient.getOracleDataForSpotMarket(marketIndex);

			// Last-price source for Last trigger orders
			const lastTriggerPrice = isVariant(marketType, 'perp')
				? (market as PerpMarketAccount).lastFillPrice ?? null
				: (market as SpotMarketAccount).lastFillPrice ?? null;

			const dlob = this.dlobSubscriber!.getDLOB();
			// Fire sweep sends ALL armed trailing nodes (TS-SPOT-3/TS-1):
			// no off-chain price filter — on-chain decides.
			const trailingNodesToFire = dlob.findTrailingStopNodesToFire(
				marketIndex,
				this.slotSubscriber.getSlot(),
				marketType,
				this.driftClient.getStateAccount(),
				oraclePriceData,
				lastTriggerPrice
			);

			for (const nodeToFire of trailingNodesToFire) {
				const now = Date.now();
				const nodeToFillSignature = getNodeToTriggerSignature(nodeToFire);
				const timeStartedToTriggerNode =
					this.triggeringNodes.get(nodeToFillSignature);
				if (timeStartedToTriggerNode) {
					if (timeStartedToTriggerNode + TRIGGER_ORDER_COOLDOWN_MS > now) {
						logger.warn(
							`firing node ${nodeToFillSignature} too soon (${
								now - timeStartedToTriggerNode
							}ms since last fire), skipping`
						);
						continue;
					}
				}

				if (nodeToFire.node.haveTrigger) {
					continue;
				}
				nodeToFire.node.haveTrigger = true;

				this.triggeringNodes.set(nodeToFillSignature, Date.now());

				logger.info(
					`trying to fire trailing stop ${marketTypeStr} order on market ${
						nodeToFire.node.order.marketIndex
					}. user: ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
				);

				try {
					const user = await this.userMap!.mustGet(
						nodeToFire.node.userAccount.toString()
					);

					let cuUnits = 100_000; // base case
					const activePositions =
						user.getActivePerpPositions().length +
						user.getActiveSpotPositions().length;
					const openOrders = user.getUserAccount().openOrders;
					cuUnits += activePositions * 15_000;
					cuUnits += openOrders * 5_000;

					const ixs = [
						ComputeBudgetProgram.setComputeUnitLimit({
							units: cuUnits,
						}),
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: Math.floor(
								this.priorityFeeSubscriber.getCustomStrategyResult() *
									this.driftClient.txSender.getSuggestedPriorityFeeMultiplier() *
									(this.triggerConfig.triggerPriorityFeeMultiplier ?? 1.0)
							),
						}),
					];

					ixs.push(
						await this.driftClient.fireTrailingStopOrder(
							new PublicKey(nodeToFire.node.userAccount),
							user.getUserAccount(),
							nodeToFire.node.order
						)
					);

					const resp = await simulateAndGetTxWithCUs({
						ixs,
						connection: this.driftClient.connection,
						payerPublicKey: this.driftClient.wallet.publicKey,
						lookupTableAccounts: this.lookupTableAccounts!,
						cuLimitMultiplier: 1.2,
						doSimulation: true,
						dumpTx: false,
						recentBlockhash: this.blockhashSubscriber.getLatestBlockhash(
							1 + Math.floor(Math.random() * 10)
						)!.blockhash as string,
					});

					if (resp.simError) {
						logger.error(
							`Error (${JSON.stringify(
								resp.simError
							)}) firing trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
						);
						continue; // finally cleans up; key NOT reserved → ratchet fallback may act
					}

					if (this.dryRun) {
						logger.info(
							`[DRY RUN] Would fire trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
						);
						continue;
					}

					await this.driftClient.sendTransaction(resp.tx);
					logger.info(
						`Fired trailing stop. user: ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}, cuUnits: ${cuUnits}`
					);

					// TS-S3-11: reserve the key ONLY if the order actually left
					// the armed state (fired to Market or cancelled Expired). A
					// non-breach Ok(()) (even with atomic fold) stays OUT so
					// ratchet still processes it (event freshness).
					await this.userMap!.sync();
					const refreshedUser = await this.userMap!.mustGet(
						nodeToFire.node.userAccount.toString()
					);
					const refreshedOrder = refreshedUser.getOrder(
						nodeToFire.node.order.orderId
					);
					if (
						!refreshedOrder ||
						!isVariant(refreshedOrder.status, 'open') ||
						!isVariant(refreshedOrder.orderType, 'trailingStop')
					) {
						this.successfulFireKeys.add(nodeToFillSignature);
					}
				} catch (e) {
					logger.error(
						`Error firing trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
					);
					logger.error(e);
				} finally {
					nodeToFire.node.haveTrigger = false;
					this.removeTriggeringNodes([nodeToFire]);
				}
			}
		} catch (e) {
			logger.error(
				`Unexpected error for ${marketTypeStr} market ${marketIndex.toString()} during fire`
			);
			console.error(e);
			if (e instanceof Error) {
				webhookMessage(
					`[${this.name}]: :x: Uncaught error:\n${
						e.stack ? e.stack : e.message
					}`
				);
			}
		}
	}

	private async tryRatchetForMarket(
		market: PerpMarketAccount | SpotMarketAccount,
		marketType: MarketType
	) {
		const marketIndex = market.marketIndex;
		const marketTypeStr = getVariant(marketType);

		try {
			const oraclePriceData = isVariant(marketType, 'perp')
				? this.driftClient.getOracleDataForPerpMarket(marketIndex)
				: this.driftClient.getOracleDataForSpotMarket(marketIndex);

			// NOTE: the ratchet sweep reads the on-chain oracle data
			// (`oraclePriceData`) for discovery; the off-chain price helper is
			// deliberately not used here (dead code removed — lint gate).
			// Last-price source for Last trigger orders
			const lastTriggerPrice = isVariant(marketType, 'perp')
				? (market as PerpMarketAccount).lastFillPrice ?? null
				: (market as SpotMarketAccount).lastFillPrice ?? null;

			// Fresh fetch was done by the orchestrator between phases; this
			// snapshot is post-fire. Candidates: non-breach + favorable +
			// unexpired (unixTs seconds, NOT slot).
			const dlob = this.dlobSubscriber!.getDLOB();
			const trailingNodesToFire = dlob.findTrailingStopNodesToRatchet(
				marketIndex,
				this.slotSubscriber.getSlot(),
				marketType,
				this.driftClient.getStateAccount(),
				oraclePriceData,
				lastTriggerPrice,
				this.clockSubscriber.getUnixTs()
			);

			const pendingSends: Array<Promise<unknown>> = [];
			for (const nodeToFire of trailingNodesToFire) {
				const now = Date.now();
				const nodeToFillSignature = getNodeToTriggerSignature(nodeToFire);
				// Skip keys the fire phase already resolved (TS-S3-10/TS-S3-11):
				// the snapshot may be stale across the phase boundary.
				if (this.successfulFireKeys.has(nodeToFillSignature)) {
					continue;
				}
				const timeStartedToTriggerNode =
					this.triggeringNodes.get(nodeToFillSignature);
				if (timeStartedToTriggerNode) {
					if (timeStartedToTriggerNode + TRIGGER_ORDER_COOLDOWN_MS > now) {
						logger.warn(
							`ratcheting node ${nodeToFillSignature} too soon (${
								now - timeStartedToTriggerNode
							}ms since last ratchet), skipping`
						);
						continue;
					}
				}

				if (nodeToFire.node.haveTrigger) {
					continue;
				}
				nodeToFire.node.haveTrigger = true;

				this.triggeringNodes.set(nodeToFillSignature, Date.now());

				try {
					logger.info(
						`trying to ratchet trailing stop ${marketTypeStr} order on market ${
							nodeToFire.node.order.marketIndex
						}. user: ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
					);

					const user = await this.userMap!.mustGet(
						nodeToFire.node.userAccount.toString()
					);

					let cuUnits = 100_000; // base case
					const activePositions =
						user.getActivePerpPositions().length +
						user.getActiveSpotPositions().length;
					const openOrders = user.getUserAccount().openOrders;
					cuUnits += activePositions * 15_000;
					cuUnits += openOrders * 5_000;

					const ixs = [
						ComputeBudgetProgram.setComputeUnitLimit({
							units: cuUnits,
						}),
						ComputeBudgetProgram.setComputeUnitPrice({
							microLamports: Math.floor(
								this.priorityFeeSubscriber.getCustomStrategyResult() *
									this.driftClient.txSender.getSuggestedPriorityFeeMultiplier() *
									(this.triggerConfig.triggerPriorityFeeMultiplier ?? 1.0)
							),
						}),
					];

					ixs.push(
						await this.driftClient.getRatchetTrailingStopOrderIx(
							new PublicKey(nodeToFire.node.userAccount),
							user.getUserAccount(),
							nodeToFire.node.order
						)
					);

					const resp = await simulateAndGetTxWithCUs({
						ixs,
						connection: this.driftClient.connection,
						payerPublicKey: this.driftClient.wallet.publicKey,
						lookupTableAccounts: this.lookupTableAccounts!,
						cuLimitMultiplier: 1.2,
						doSimulation: true,
						dumpTx: false,
						recentBlockhash: this.blockhashSubscriber.getLatestBlockhash(
							1 + Math.floor(Math.random() * 10)
						)!.blockhash as string,
					});

					if (resp.simError) {
						logger.error(
							`Error (${JSON.stringify(
								resp.simError
							)}) ratcheting trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
						);
						nodeToFire.node.haveTrigger = false;
						this.removeTriggeringNodes([nodeToFire]);
						continue;
					} else {
						if (this.dryRun) {
							logger.info(
								`[DRY RUN] Would ratchet trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
							);
							nodeToFire.node.haveTrigger = false;
							this.removeTriggeringNodes([nodeToFire]);
						} else {
							pendingSends.push(
								this.driftClient
									.sendTransaction(resp.tx)
									.then((txSig) => {
										logger.info(
											`Ratcheted trailing stop. user: ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}: ${
												txSig.txSig
											}, cuUnits: ${cuUnits}`
										);
									})
									.catch((error) => {
										nodeToFire.node.haveTrigger = false;

										const errorCode = getErrorCode(error);
										if (
											errorCode &&
											!errorCodesToSuppress.includes(errorCode) &&
											!(error as Error).message.includes(
												'Transaction was not confirmed'
											)
										) {
											if (errorCode) {
												this.errorCounter!.add(1, {
													errorCode: errorCode.toString(),
												});
											}
											logger.error(
												`Error ratcheting trailing stop for user ${nodeToFire.node.userAccount.toString()}-${nodeToFire.node.order.orderId.toString()}`
											);
											logger.error(error);
										}
									})
									.finally(() => {
										this.removeTriggeringNodes([nodeToFire]);
									})
							);
						}
					}
				} finally {
					// Per-node cleanup on EVERY path (CODE-2): sim/dry-run/
					// send branches above also clean up, but exceptions from
					// mustGet/ix-build/simulate escape straight here.
					nodeToFire.node.haveTrigger = false;
					this.removeTriggeringNodes([nodeToFire]);
				}
			}
			await Promise.allSettled(pendingSends);
		} catch (e) {
			logger.error(
				`Unexpected error for ${marketTypeStr} market ${marketIndex.toString()} during ratchet`
			);
			console.error(e);
			if (e instanceof Error) {
				webhookMessage(
					`[${this.name}]: :x: Uncaught error:\n${
						e.stack ? e.stack : e.message
					}`
				);
			}
		}
	}

	private removeTriggeringNodes(nodes: Array<NodeToTrigger>) {
		for (const node of nodes) {
			this.triggeringNodes.delete(getNodeToTriggerSignature(node));
		}
	}

	private async tryTrigger() {
		const start = Date.now();
		let ran = false;
		try {
			await tryAcquire(this.periodicTaskMutex).runExclusive(async () => {
				// CODE-2 med FIX: successfulFireKeys must be cleared even if
				// updateDLOB() (or any phase) throws between fire and ratchet —
				// otherwise stale keys suppress ratchet in later rounds.
				try {
					// Phase 1 — fire-1 + fire-2 (flattened, fully awaited; every
					// inner map returns its promises — TS-S3-5).
					await Promise.all([
						...this.driftClient
							.getPerpMarketAccounts()
							.map((marketAccount) =>
								this.tryTriggerForMarket(marketAccount, MarketType.PERP)
							),
						...this.driftClient
							.getSpotMarketAccounts()
							.map((marketAccount) =>
								this.tryTriggerForMarket(marketAccount, MarketType.SPOT)
							),
						...this.driftClient
							.getPerpMarketAccounts()
							.map((marketAccount) =>
								this.tryFireTrailingForMarket(marketAccount, MarketType.PERP)
							),
						...this.driftClient
							.getSpotMarketAccounts()
							.map((marketAccount) =>
								this.tryFireTrailingForMarket(marketAccount, MarketType.SPOT)
							),
					]);
					// Fresh DLOB between phases: rebuild runs on a timer, async to
					// the phase boundary (TS-S3-10).
					await this.dlobSubscriber!.updateDLOB();
					// Phase 2 — ratchet fallback.
					await Promise.all([
						...this.driftClient
							.getPerpMarketAccounts()
							.map((marketAccount) =>
								this.tryRatchetForMarket(marketAccount, MarketType.PERP)
							),
						...this.driftClient
							.getSpotMarketAccounts()
							.map((marketAccount) =>
								this.tryRatchetForMarket(marketAccount, MarketType.SPOT)
							),
					]);
				} finally {
					this.successfulFireKeys.clear();
				}
				ran = true;
			});
		} catch (e) {
			if (e === E_ALREADY_LOCKED) {
				const user = this.driftClient.getUser();
				this.mutexBusyCounter!.add(
					1,
					metricAttrFromUserAccount(
						user.getUserAccountPublicKey(),
						user.getUserAccount()
					)
				);
			} else {
				if (e instanceof Error) {
					webhookMessage(
						`[${this.name}]: :x: Uncaught error in main loop:\n${
							e.stack ? e.stack : e.message
						}`
					);
				}
				throw e;
			}
		} finally {
			if (ran) {
				const user = this.driftClient.getUser();

				const duration = Date.now() - start;
				if (this.tryTriggerDurationHistogram) {
					this.tryTriggerDurationHistogram!.record(
						duration,
						metricAttrFromUserAccount(
							user.getUserAccountPublicKey(),
							user.getUserAccount()
						)
					);
				}

				logger.debug(`${this.name} Bot took ${duration}ms to run`);
				await this.watchdogTimerMutex.runExclusive(async () => {
					this.watchdogTimerLastPatTime = Date.now();
				});
			}
		}
	}
}
