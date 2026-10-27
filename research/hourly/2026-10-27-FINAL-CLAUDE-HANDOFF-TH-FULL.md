# POC Signal — รายงานวิจัยรวมฉบับสุดท้าย 27 ต.ค. 2569 สำหรับ Claude

สถานะ: **NOT PASSED / RESEARCH ONLY** ไม่มีหลักฐานกำไรสุทธิที่สม่ำเสมอพอสำหรับเทรดเงินจริงหรือเลี้ยงชีพ ห้ามส่งออร์เดอร์, Push main, Merge, Deploy, แก้ Production หรือเพิ่ม Leverage เพื่อกลบผลขาดทุน

## แหล่งอ้างอิง
GitHub: https://github.com/glasskitchenware-cmd/poc-backtest
main commit: 089daf5c8b13b13771108bcc615ea569624877f4
branch: research/hourly-20261027
Drive: https://drive.google.com/drive/folders/1TddMOq93eOK_omMoccsU_sEC1yPd1urb
อ่านบันทึก research/hourly/2026-10-27-1600.md, -1700.md, -1800.md, -1900.md, causal-signal.md, 2033-score-stability.md, 2055-tp-config.md, 2100-full-tp-lifecycle.md และสคริปต์ audit_recent.js, audit_cohort.js, audit_poc_filter.py, audit_signal_causality.js, audit_score_stability.py, audit_tp_config_2055.js, audit_full_tp_lifecycle_2100.js ก่อนเริ่มงานใหม่

## VERIFIED — หลักฐานจำลองที่ตรวจได้
POC Breakout B_baseline 2025–ก.ย.2026: 2,835 ไม้, net −607.787R, mean −0.2144R/ไม้, gross ก่อนต้นทุน −90.919R, AUC 0.4995. เป็น saved simulated ledger ที่ถูกศึกษาแล้ว ไม่ใช่ untouched OOS หรือเงินจริง. BTC 366 ไม้ −100.348R, ETH 944 ไม้ −195.993R, SOL 1,525 ไม้ −311.446R; LONG 1,329 ไม้ −309.365R, SHORT 1,506 ไม้ −298.422R; 1/21 เดือนบวก. ตัวกรองคะแนน 50/55/60% ปฏิเสธทุกไม้เพราะคะแนนอยู่ประมาณ 0.32955–0.37264; ตัดไม้แพ้ 1,789 ไม้และไม้ชนะ 1,046 ไม้พร้อมกัน จึงไม่สร้างกำไร

ตรวจ decisions/ledger 6,100/6,100 แถว, ต้นทุน gross−fee−slip−funding=netR ตรงกัน และสร้างสัญญาณจาก OHLCV เดิมซ้ำได้ 6,100/6,100, causal-prefix checks 9/9. นี่เป็น correctness ของ simulation ไม่ใช่การยืนยันราคาหรือ fills จริง

Trend4H คนละกลยุทธ์: 15 ไม้ last30 −4.494R; 3 ไม้เข้าก่อนช่วง +2.903R, 12 ไม้เข้าระหว่างช่วง −7.397R. ทั้ง 6 leave-one-entry-week-out ติดลบ, zero-cost gross ราว −3.45R, double-cost arithmetic ราว −5.53R, 12/15 ถือเกิน 24 ชั่วโมง ห้ามนำมารวมกับ POC

Relative Value 16 สูตร, breakout 1h 8 สูตร, fade 8 สูตร, anchored VWAP reversion 8 สูตร ไม่ผ่าน validation 2024. Score-stability Q10–Q90 ที่ calibrate จากปี 2023 ยังติดลบทั้ง 2024 และ historical pseudo-test 2025–ก.ย.2026. Forecast archive 196,972 รายการมีทิศทางใกล้ 50% และ MAE ส่วนใหญ่แย่กว่าทายศูนย์. Post-hoc 1h k3 gross-minus-cost +0.9447bps จาก 267 overlapping opportunities ไม่ใช่ tradable PnL

Portfolio replay จาก ledger จำลองทุน 10,000 USDT, risk 0.25%/ไม้: base รับ 132 ไม้ net ราว −779 USDT, close DD ราว 8.03%; cost x2 รับ 94 ไม้ net ราว −823 USDT, DD ราว 8.23%. ไม่ใช่ full exchange execution replay หรือ intrabar MTM

## VERIFIED — ปัญหาโค้ดที่ตรวจจาก synthetic fixtures
web/trend.js blob SHA 9256dfcd7f2bd75d75c18f23ccc2aaba435d49dc มีปัญหา slippage ที่สะท้อนในราคา fill แล้วหักเป็น cost ซ้ำบางกรณี และ fee reconciliation ไม่ตรง executed notional. ต้องทำ independent fill ledger ก่อนแก้หรืออ้างกำไร

20:55 optional TP config ไม่ตรวจ ascending target และ fractions: สลับ 2R/1R ทำให้พลาด TP ที่แตะ, sum fraction 1.2 ทำให้เหลือ −20%, fraction −0.2 ทำให้เหลือ 120%. 4 synthetic executions

21:00 ตรวจเพิ่มด้วยโค้ด main จริงและ synthetic OHLC 230 แท่ง 4h สองกรณี: ตั้ง TP 1R/2R fraction .5/.5 เมื่อ fill ครบ 100% แล้ว live mode ยังมี pos.left=0 แต่ pos ไม่ null, trades=0 และบล็อกสัญญาณใหม่; หากราคากระโดดลงภายหลัง ระบบกลับบันทึก stop_gap แม้สถานะออกครบไปแล้ว, R=+1.5. เป็น lifecycle defect ของ optional full scale-out, ไม่ใช่ผลตลาดจริง; default tps=[] ไม่ได้รับผลโดยตรง

## สถิติที่รันจริงและข้อจำกัด
POC weekly bootstrap เดิม 100,000 draws mean-R CI95 [−0.25684,−0.17300] และ 2,000 AUC draws CI95 [0.48016,0.52106], seed 20261027, block=UTC entry week across 3 coins. Forecast weekly bootstrap อีก 40,000 draws. Trend4H exact 6-week bootstrap 46,656 resamples, CI95 mean R [−0.688,+0.363]. ทั้งหมดเป็น resamples ของข้อมูลเดิม ไม่ใช่ข้อมูลอิสระ
รอบ 21:00 ใหม่: deterministic synthetic executions 2, market observations 0, Monte Carlo 0, bootstrap 0, permutation 0, seed/block/CI/bias N/A, estimand = correctness ของ TP lifecycle. ไม่อ้างรัน 1 ล้าน/10 ล้านครั้งหากไม่มีจริง

## UNKNOWN
Untouched OOS ใหม่ >=200 ไม้, signed funding, orderbook/spread/latency, tick-level stop/TP ordering, adverse intrabar DD, margin/liquidation, event regime FOMC/CPI/NFP ที่ทดสอบจริง, purged walk-forward และ forward paper ledger; เงินทุนและค่าใช้จ่ายเลี้ยงชีพจริง

## เกณฑ์อนุมัติที่ล็อก
Untouched OOS >=200 trades, net PF>=1.15, กำไรสุทธิ >=2 ช่วงไม่ทับกัน, >=60% เดือนบวก, close DD<=8% พร้อม adverse intrabar bound, 2x full execution costs แล้วยังบวก, purged walk-forward/embargo และ forward paper trade ผ่าน. ห้ามเลือก test outlier หรือผ่อนเกณฑ์ย้อนหลัง

## คำสั่งส่งต่อ Claude
เขียน expected-failing regression สำหรับ unsorted/duplicate/NaN/negative/overfull TP และ sum=1 ghost position; เลือกนโยบาย reject sum=1 หรือปิดสถานะทันทีที่ fill ครบพร้อม timestamp ที่ถูกต้อง. ทำ independent fill/cashflow engine คิด slippage ครั้งเดียว fee ตาม executed notional signed funding และ stop-first/gap/partial TP. คง entry/SL/TP เดิมเมื่อทดลอง filter และแยก volatility-aware SL/TP เป็น experiment อื่น. วัด avoided losers, discarded winners, net expectancy, cluster/heat, calendar/regime, liquidity และ DD. เก็บ source hash, raw ledger, seed, sample size, block size, estimand, CI, bias, sensitivity และ iteration count ที่รันจริง. ห้าม Merge/Deploy/ส่งออร์เดอร์

สรุป: **NOT PASSED**.