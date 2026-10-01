import {
	OffsetType,
	OrderStatus,
	OrderType,
	MarketType,
	PositionDirection,
	OrderTriggerCondition,
	SpotBalanceType,
	NodeToFill,
	DLOBNode,
	NodeToTrigger,
	PublicKey,
} from '@velocity-exchange/sdk';

export type SerializedUserAccount = {
	authority: string;
	delegate: string;
	name: number[];
	subAccountId: number;
	spotPositions: SerializedSpotPosition[];
	perpPositions: SerializedPerpPosition[];
	orders: SerializedOrder[];
	status: number;
	nextLiquidationId: number;
	nextOrderId: number;
	maxMarginRatio: number;
	settledPerpPnl: string;
	totalDeposits: string;
	totalWithdraws: string;
	totalSocialLoss: string;
	cumulativePerpFunding: string;
	cumulativeSpotFees: string;
	liquidationMarginFreed: string;
	lastActiveSlot: string;
	isMarginTradingEnabled: boolean;
	idle: boolean;
	openOrders: number;
	hasOpenOrder: boolean;
	openAuctions: number;
	hasOpenAuction: boolean;
};

/**
 * Lưu ý (contract IPC): consumer PHẢI truy cập theo TÊN field, không theo vị trí.
 * `trailingPrice`/`callbackRate`/`offsetType` đã được thêm ⇒ `Object.keys().length`
 * và mọi decode positional sẽ đổi. Runtime serialize luôn trả string cho field
 * BN (xem `serializeOrder`).
 */
export type SerializedOrder = {
	status: OrderStatus;
	orderType: OrderType;
	marketType: MarketType;
	slot: string;
	orderId: number;
	userOrderId: number;
	marketIndex: number;
	price: string;
	baseAssetAmount: string;
	quoteAssetAmount: string;
	baseAssetAmountFilled: string;
	quoteAssetAmountFilled: string;
	direction: PositionDirection;
	reduceOnly: boolean;
	triggerPrice: string;
	triggerCondition: OrderTriggerCondition;
	existingPositionDirection: PositionDirection;
	postOnly: boolean;
	immediateOrCancel: boolean;
	offset: number;
	offsetType: OffsetType;
	auctionDuration: number;
	auctionStartPrice: string;
	auctionEndPrice: string;
	maxTs: string;
	bitFlags: number;
	postedSlotTail: number;
	/// Trailing-stop fields (không serialize: luôn là 0 sau khi round-trip vì
	/// DLOB không dùng chúng; giữ cho khớp `Order`).
	trailingPrice: string;
	callbackRate: string;
};

export type SerializedSpotPosition = {
	marketIndex: number;
	balanceType: SpotBalanceType;
	scaledBalance: string;
	openOrders: number;
	openBids: string;
	openAsks: string;
	cumulativeDeposits: string;
};

export type SerializedPerpPosition = {
	baseAssetAmount: string;
	lastCumulativeFundingRate: string;
	marketIndex: number;
	quoteAssetAmount: string;
	quoteEntryAmount: string;
	quoteBreakEvenAmount: string;
	openOrders: number;
	openBids: string;
	openAsks: string;
	settledPnl: string;
	remainderBaseAssetAmount: number;
	isolatedPositionScaledBalance: string;
	positionFlag: number;
};

export type SerializedNodeToTrigger = {
	node: SerializedTriggerOrderNode;
	makers: string[];
};

export type SerializedTriggerOrderNode = {
	order: SerializedOrder;
	userAccountData: Buffer;
	userAccount: string;
	sortValue: string;
	haveFilled: boolean;
	haveTrigger: boolean;
	isSignedMsg: boolean;
	isProtectedMaker: boolean;
};

export type SerializedNodeToFill = {
	fallbackAskSource?: FallbackLiquiditySource;
	fallbackBidSource?: FallbackLiquiditySource;
	node: SerializedDLOBNode;
	makerNodes: SerializedDLOBNode[];
	authority?: string;
};

export type SerializedDLOBNode = {
	type: string;
	order: SerializedOrder;
	userAccountData?: Buffer;
	userAccount: string;
	sortValue: string;
	haveFilled: boolean;
	haveTrigger?: boolean;
	fallbackAskSource?: FallbackLiquiditySource;
	fallbackBidSource?: FallbackLiquiditySource;
	isSignedMsg?: boolean;
};

export type FallbackLiquiditySource = 'phoenix' | 'openbook';
export type NodeToFillWithContext = NodeToFill & {
	fallbackAskSource?: FallbackLiquiditySource;
	fallbackBidSource?: FallbackLiquiditySource;
};

export type NodeToFillWithBuffer = {
	userAccountData?: Buffer;
	makerAccountData: string;
	node: DLOBNode;
	fallbackAskSource?: FallbackLiquiditySource;
	fallbackBidSource?: FallbackLiquiditySource;
	makerNodes: DLOBNode[];
	authority?: string;
};

export type NodeToTriggerWithMakers = NodeToTrigger & {
	makers: PublicKey[];
};
