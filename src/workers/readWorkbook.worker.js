import readExcelFile from "read-excel-file/web-worker";
import { workbookFromSheets } from "../lib/workbookRows.js";

self.onmessage = async event => {
  try {
    const sheets = await readExcelFile(event.data.file);
    self.postMessage({ ok:true, workbook:workbookFromSheets(sheets) });
  } catch (error) {
    self.postMessage({
      ok:false,
      error:error?.message || "Could not read workbook",
    });
  }
};