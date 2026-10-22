# POC Backtest

เว็บแอปสำหรับมือถือ: ดึงแท่ง 15 นาทีที่ปิดแล้วของ BTC/USDT และ ETH/USDT จาก Binance (public API ไม่ต้องใช้ key) แล้ว backtest กลยุทธ์ POC rejection + เทรนด์ 1 ชั่วโมงในเบราว์เซอร์ แสดง win rate พร้อมช่วงเชื่อมั่น 95%, profit factor, Max DD และกราฟแท่งเทียน

เปิดใช้: https://glasskitchenware-cmd.github.io/poc-backtest/

- Backtest อย่างเดียว ไม่มีการส่งคำสั่งซื้อขาย ไม่มี server ทุกอย่างคำนวณในเครื่อง
- ทดสอบกฎราคาอย่างเดียว ไม่ได้จำลองตัวกรองข่าว ผลในอดีตไม่รับประกันอนาคต
- `index.html` สร้างจากโปรเจกต์ crypto-paper-bot (ตัวคำนวณตรวจแล้วว่าให้ผลตรงกับเวอร์ชัน Python ทุกไม้)
- กราฟ: TradingView Lightweight Charts™ v4.2.3, Apache-2.0 (ดู `LICENSE-lightweight-charts.txt`)
