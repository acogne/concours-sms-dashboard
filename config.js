// Configuration du dashboard concours SMS
// La liste des concours est désormais détectée automatiquement depuis les
// onglets du Google Sheet (voir discoverContests() dans app.js).

const DASHBOARD_CONFIG = {
  // Colle ici le même Client ID OAuth que celui utilisé par le dashboard hebdo
  // (Google Cloud Console > APIs & Services > Identifiants)
  googleClientId: "476748970851-jfaraub4h66nvht8isqkf66nfks9g5qs.apps.googleusercontent.com",
  sheetIds: {
    "Concours": "1JmzBRHm6DLNl0R2hgF3SgLV_JWHmdobOVcayzyKZVZQ",
    "Media One": "1dfgsZxwcXwnwMWICYHoDOxjGNWuh3Fz40Skow19i6XU"
  }
};
