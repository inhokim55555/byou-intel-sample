import readExcelFile from "read-excel-file/web-worker";

self.onmessage = async event => {
  try {
    const sheets = await readExcelFile(event.data.file);
    self.postMessage({ ok:true, sheets });
  } catch (error) {
    self.postMessage({ ok:false, error:error?.message || "Could not read the P&L workbook." });
  }
};
