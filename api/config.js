// Public settings the page needs before it can sign people in. The client ID is not a secret.
export default function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({ googleClientId: String(process.env.GOOGLE_CLIENT_ID || "").trim() || null });
}
