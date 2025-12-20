import { emitInvoicesForReadyTickets } from "../invoices.js";

console.log("[job] emitInvoicesJob start");
emitInvoicesForReadyTickets()
  .then((r) => console.log("[job] emitInvoicesJob done", r))
  .catch(console.error);
