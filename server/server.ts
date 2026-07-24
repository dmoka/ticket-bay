// Minimal booking UI server — real modules, in-memory orders. Serves the demo flow:
// pick tickets -> book -> cancel -> see the refund amount.
import { createServer } from "node:http";
import { bookTickets, groupDiscount, Event } from "../src/booking";
import { netRefund, Order } from "../src/refund";

const PORT = Number(process.env.PORT ?? 4173);
const event: Event = {
  id: "rockfest",
  name: "RockFest 2026",
  totalSeats: 100,
  seatsSold: 40,
  priceCents: 5000,
  startMs: Date.now() + 30 * 24 * 3600 * 1000,
};
const orders = new Map<number, Order>();
let nextId = 1;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>TicketBay</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px}
button{padding:8px 16px;margin:8px 0}#refund-amount{font-weight:bold}</style></head><body>
<h1>TicketBay</h1><h2>RockFest 2026 — €50.00 per ticket</h2>
<form id="book-form"><label>Tickets: <input id="tickets" name="tickets" type="number" value="2" min="1"></label>
<button type="submit">Book tickets</button></form>
<p id="order-info" hidden>Paid: <span id="paid-amount"></span> cents (order <span id="order-id"></span>)</p>
<button id="cancel-btn" hidden>Cancel order</button>
<p id="refund-info" hidden>Refunded: <span id="refund-amount"></span> cents</p>
<script>
const form=document.getElementById('book-form');
form.addEventListener('submit',async(e)=>{e.preventDefault();
const n=Number(document.getElementById('tickets').value);
const r=await fetch('/api/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tickets:n})});
const d=await r.json();
document.getElementById('paid-amount').textContent=d.totalCents;
document.getElementById('order-id').textContent=d.id;
document.getElementById('order-info').hidden=false;
const btn=document.getElementById('cancel-btn');btn.hidden=false;
btn.onclick=async()=>{const rr=await fetch('/api/refund',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:d.id})});
const rd=await rr.json();
document.getElementById('refund-amount').textContent=rd.refundCents;
document.getElementById('refund-info').hidden=false;};
});
</script></body></html>`;

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" }).end(page);
    return;
  }
  if (req.method === "POST" && (req.url === "/api/book" || req.url === "/api/refund")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body || "{}");
    try {
      if (req.url === "/api/book") {
        const order = bookTickets(event, data.tickets, groupDiscount(data.tickets));
        const id = nextId++;
        orders.set(id, order);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, ...order }));
      } else {
        const order = orders.get(data.id);
        if (!order) throw new RangeError("no such order");
        const refundCents = netRefund(order, order.tickets, Date.now());
        orders.delete(data.id);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ refundCents }));
      }
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e) }));
    }
    return;
  }
  res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
}).listen(PORT, () => console.log(`TicketBay UI on http://localhost:${PORT}`));
