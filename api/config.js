// Public settings the page needs before it can sign people in. The client ID is not a secret.
// country: where the visitor is connecting from (Vercel's IP lookup), so prices show in rupees in India
// and in US dollars everywhere else. "private" keeps shared caches from serving one visitor's country to another.
export default function handler(req, res) {
  res.setHeader("cache-control", "private, max-age=300");
  const country = String(req.headers["x-vercel-ip-country"] || "").toUpperCase();
  res.status(200).json({ googleClientId: String(process.env.GOOGLE_CLIENT_ID || "").trim() || null, country: /^[A-Z]{2}$/.test(country) ? country : null });
}
