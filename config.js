// Configuration du dashboard concours SMS
// À chaque nouveau concours : ajouter une ligne dans "contests" ci-dessous.
// "sheetTab" doit correspondre EXACTEMENT au nom de l'onglet dans le Google Sheet.

const DASHBOARD_CONFIG = {
  sheetId: "1JmzBRHm6DLNl0R2hgF3SgLV_JWHmdobOVcayzyKZVZQ",
  contests: [
    {
      id: "celine-dion",
      label: "Céline Dion",
      sheetTab: "Céline Dion",
      station: "One FM",
      keyword: "CÉLINE"
    }
    // { id: "prochain-concours", label: "Nom du concours", sheetTab: "Nom de l'onglet", station: "One FM", keyword: "MOTCLE" },
  ]
};
