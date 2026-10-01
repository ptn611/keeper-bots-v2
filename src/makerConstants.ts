/**
 * Hằng số dùng chung cho logic chọn maker.
 *
 * Tách ra module lá (không import gì) vì `MAX_MAKERS_PER_FILL` trước đây bị **khai bốn
 * lần** ở bốn file (`bots/filler.ts`, `bots/spotFiller.ts`,
 * `experimental-bots/filler/fillerMultithreaded.ts`,
 * `experimental-bots/spotFiller/spotFillerMultithreaded.ts`). Hệ quả: `src/makerSelection.ts`
 * (và `src/types.test.ts` test nó) phải import cả graph của filler ⇒ kéo theo
 * `bundleSender` → `jito-ts` → `@solana/web3.js@1.77` → `rpc-websockets/dist/lib/client`,
 * làm `yarn test` fail với lỗi module không tồn tại (xem AUDIT_HANDOFF change set (g) §2).
 *
 * Nay **một nguồn duy nhất**: cả bốn file trên đều import từ đây. Hai file re-export
 * (`bots/filler.ts`, `experimental-bots/filler/fillerMultithreaded.ts`) để không phá
 * consumer cũ đang import hằng số từ chúng.
 *
 * Ở đây chỉ có hằng số thuần ⇒ import không kéo theo side effect nào.
 */

/**
 * Số maker tối đa được chọn cho mỗi lần fill.
 *
 * Giữ đúng giá trị 6 như bốn bản copy trước đó
 * (`bots/filler.ts`, `bots/spotFiller.ts`,
 * `experimental-bots/filler/fillerMultithreaded.ts`,
 * `experimental-bots/spotFiller/spotFillerMultithreaded.ts`).
 */
export const MAX_MAKERS_PER_FILL = 6;
