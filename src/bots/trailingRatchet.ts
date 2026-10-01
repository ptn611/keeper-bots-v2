import {
	BN,
	isVariant,
	PositionDirection,
	TEN_THOUSAND,
} from '@velocity-exchange/sdk';

/**
 * Ngưỡng throttle thuần (không state, không I/O) cho crank ratchet.
 *
 * Mirror đúng fold của on-chain `fire_trailing_stop_order`: `Short` (sell) fold khi
 * `ref > trailingPrice`, `Long` (buy) fold khi `ref < trailingPrice`. Ngưỡng tính
 * trên `trailingPrice` — đó mới là biến mà fold thay đổi.
 *
 * So sánh dùng `>=`/`<=` (fold đủ ngưỡng là crank) cho khớp nghĩa "min move" của
 * config; ngưỡng làm tròn xuống nên lệch tối đa < 1 đơn vị giá.
 *
 * Fail-safe: mọi input thiếu/0 ⇒ `true` (vẫn gửi tx như trước). Chỉ `false` khi chắc
 * chắn fold không dịch chuyển đáng kể ⇒ chỉ mất độ tươi của ký ức đỉnh, **không** ảnh
 * hưởng quyết định fire (fire-2 tự fold lại giá live trong tx của nó).
 *
 * CỐ Ý CHẶT HƠN CONTRACT: on-chain `ratchet_trailing_stop_order` fold MỌI biến động
 * thuận lợi, còn keeper chỉ crank khi move ≥ `minMoveBps`. Đây là tối ưu (giảm số tx
 * ~11.4k CU + 5_000 lamports mỗi lần), không phải lệch logic: giá trị cuối cùng của
 * `Order.trailing_price` luôn do contract quyết định trong chính tx fire-2. Hệ quả
 * duy nhất là `trailing_price` trên chain có thể "lệch" so với đỉnh lịch sử trong
 * khoảng thời gian crank chưa chạy — đây chính là đánh đổi đã chấp nhận, và lý do
 * `ratchetMinFavorableMoveBps` mặc định chỉ 10 bps (0,1%).
 */
export function favorableMoveExceedsBps(
	trailingPrice: BN | undefined,
	refPrice: BN | undefined,
	direction: PositionDirection,
	minMoveBps: number
): boolean {
	if (minMoveBps <= 0 || minMoveBps >= 10_000) {
		return true;
	}
	if (!trailingPrice || trailingPrice.isZero()) {
		return true;
	}
	if (!refPrice || refPrice.isZero()) {
		return true;
	}
	const threshold = trailingPrice.mul(new BN(minMoveBps)).div(TEN_THOUSAND);
	if (isVariant(direction, 'short')) {
		return refPrice.gte(trailingPrice.add(threshold));
	}
	return refPrice.lte(trailingPrice.sub(threshold));
}
