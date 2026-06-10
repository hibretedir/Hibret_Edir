let invoiceStatsCache = { at: 0, data: null };
const INVOICE_STATS_TTL_MS = 60000;

function getInvoiceStatsCache() {
  return invoiceStatsCache;
}

function setInvoiceStatsCache(data) {
  invoiceStatsCache = { at: Date.now(), data };
}

function isInvoiceStatsCacheFresh() {
  return invoiceStatsCache.data && Date.now() - invoiceStatsCache.at < INVOICE_STATS_TTL_MS;
}

function invalidateInvoiceStatsCache() {
  invoiceStatsCache = { at: 0, data: null };
}

module.exports = {
  INVOICE_STATS_TTL_MS,
  getInvoiceStatsCache,
  setInvoiceStatsCache,
  isInvoiceStatsCacheFresh,
  invalidateInvoiceStatsCache,
};
