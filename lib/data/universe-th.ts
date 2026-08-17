// Curated SET large/mid-cap universe for the screener. Not the full SET50/SET100 —
// expandable later; the refresh job already tolerates individual bad/delisted tickers.
export const UNIVERSE_TH: readonly string[] = [
  // Banks
  "KBANK.BK", "SCB.BK", "BBL.BK", "KTB.BK", "TTB.BK", "TISCO.BK", "KKP.BK",
  // Energy / petrochemicals
  "PTT.BK", "PTTEP.BK", "PTTGC.BK", "TOP.BK", "IRPC.BK", "BANPU.BK", "GPSC.BK", "GULF.BK", "RATCH.BK",
  // Telecom
  "ADVANC.BK", "TRUE.BK", "INTUCH.BK",
  // Retail / consumer
  "CPALL.BK", "CPAXT.BK", "HMPRO.BK", "CRC.BK", "BJC.BK",
  // Food / agro
  "CPF.BK", "TU.BK", "OSP.BK", "MINT.BK",
  // Property
  "LH.BK", "AP.BK", "SPALI.BK", "ORI.BK", "SIRI.BK", "CPN.BK", "WHA.BK",
  // Industrial / electronics
  "DELTA.BK", "HANA.BK", "KCE.BK", "SCC.BK", "SCGP.BK",
  // Healthcare
  "BDMS.BK", "BH.BK", "CHG.BK",
  // Transport / infrastructure
  "AOT.BK", "BEM.BK", "BTS.BK",
  // Materials / others
  "IVL.BK", "EA.BK", "TIDLOR.BK", "KTC.BK", "SAWAD.BK",
];
