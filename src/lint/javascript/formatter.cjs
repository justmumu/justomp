// Native ESLint formatter kept outside manager archives (including Yarn PnP ZipFS).
// Source text is deliberately absent from the diagnostic transport.
module.exports = (results) =>
  JSON.stringify(
    results.map(({ filePath, messages }) => ({ filePath, messages })),
  );
