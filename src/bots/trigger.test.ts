import { assert } from 'chai';
import { BN } from '@velocity-exchange/sdk';
import { PositionDirection } from '@velocity-exchange/sdk';
import { favorableMoveExceedsBps } from './trailingRatchet';

const P = new BN(1_000_000); // price 1.0
const bps = (n: number, base = P) => base.mul(new BN(n)).div(new BN(10_000));

describe('favorableMoveExceedsBps (ratchet throttle)', () => {
	// ---- Short (sell trailing stop): fold khi ref > trailing ----
	it('short: giá không đổi ⇒ không crank', () => {
		assert.isFalse(favorableMoveExceedsBps(P, P, PositionDirection.SHORT, 10));
	});

	it('short: tăng dưới ngưỡng (1 bps < 10 bps) ⇒ không crank', () => {
		assert.isFalse(
			favorableMoveExceedsBps(P, P.add(bps(1)), PositionDirection.SHORT, 10)
		);
	});

	it('short: tăng đúng ngưỡng 10 bps ⇒ crank', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, P.add(bps(10)), PositionDirection.SHORT, 10)
		);
	});

	it('short: tăng vượt ngưỡng ⇒ crank', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, P.add(bps(25)), PositionDirection.SHORT, 10)
		);
	});

	it('short: giảm ⇒ không crank (fold không di chuyển)', () => {
		assert.isFalse(
			favorableMoveExceedsBps(P, P.sub(bps(50)), PositionDirection.SHORT, 10)
		);
	});

	// ---- Long (buy trailing stop): fold khi ref < trailing ----
	it('long: giá không đổi ⇒ không crank', () => {
		assert.isFalse(favorableMoveExceedsBps(P, P, PositionDirection.LONG, 10));
	});

	it('long: giảm dưới ngưỡng ⇒ không crank', () => {
		assert.isFalse(
			favorableMoveExceedsBps(P, P.sub(bps(3)), PositionDirection.LONG, 10)
		);
	});

	it('long: giảm đúng ngưỡng 10 bps ⇒ crank', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, P.sub(bps(10)), PositionDirection.LONG, 10)
		);
	});

	it('long: tăng ⇒ không crank', () => {
		assert.isFalse(
			favorableMoveExceedsBps(P, P.add(bps(100)), PositionDirection.LONG, 10)
		);
	});

	// ---- fail-safe: thiếu dữ liệu ⇒ vẫn gửi tx (không bỏ sót) ----
	it('fail-safe: trailingPrice = 0 ⇒ true', () => {
		assert.isTrue(
			favorableMoveExceedsBps(new BN(0), P, PositionDirection.SHORT, 10)
		);
	});

	it('fail-safe: trailingPrice undefined ⇒ true', () => {
		assert.isTrue(
			favorableMoveExceedsBps(undefined, P, PositionDirection.SHORT, 10)
		);
	});

	it('fail-safe: refPrice undefined ⇒ true', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, undefined, PositionDirection.SHORT, 10)
		);
	});

	it('fail-safe: refPrice = 0 ⇒ true', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, new BN(0), PositionDirection.SHORT, 10)
		);
	});

	// ---- throttle tắt ----
	it('minMoveBps = 0 ⇒ luôn true (tắt throttle)', () => {
		assert.isTrue(favorableMoveExceedsBps(P, P, PositionDirection.SHORT, 0));
		assert.isTrue(favorableMoveExceedsBps(P, P, PositionDirection.LONG, 0));
	});

	it('minMoveBps = 10.000 ⇒ luôn true (bỏ qua, không âm threshold)', () => {
		assert.isTrue(
			favorableMoveExceedsBps(P, P, PositionDirection.SHORT, 10_000)
		);
	});

	// ---- ngưỡng trên trailingPrice, không trên activation ----
	it('ngưỡng tính trên trailingPrice: giá tăng 5 bps với trailing lớn hơn vẫn bị chặn nếu < bps', () => {
		const tp = new BN(2_000_000);
		assert.isFalse(
			favorableMoveExceedsBps(
				tp,
				tp.add(tp.mul(new BN(5)).div(new BN(10_000))),
				PositionDirection.SHORT,
				10
			)
		);
	});

	it('long với trailing nhỏ: threshold không làm âm ⇒ vẫn hành xử đúng', () => {
		const tp = new BN(1000); // price 0.001
		assert.isTrue(
			favorableMoveExceedsBps(tp, new BN(500), PositionDirection.LONG, 10)
		);
		assert.isFalse(
			favorableMoveExceedsBps(tp, new BN(1000), PositionDirection.LONG, 10)
		);
	});
});
