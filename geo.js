// EssayWiz: visitors in India see prices in rupees, everyone else in US dollars. There is no switch.
// The country comes from the visitor's internet connection (Vercel, via /api/config); until that answer
// arrives, the device's timezone and language are a quick first guess.
//   <span data-inr="₹199 a month">$5 USD a month</span>  shows the data-inr text in India
//   data-only="IN" / data-only="XX"                     shows an element only in India / only elsewhere
// window.ewCountryReady resolves to true (India) or false once the country is known.
(function () {
  var guess = false;
  try { guess = /^Asia\/(Kolkata|Calcutta)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone) || /-IN$/i.test(navigator.language || ""); } catch (e) {}
  var saved = null;
  try { saved = sessionStorage.getItem("ew_country"); } catch (e) {}

  function apply(india) {
    window.ewIndia = india;
    document.documentElement.setAttribute("data-country", india ? "IN" : "XX");
    var swaps = document.querySelectorAll("[data-inr]");
    for (var i = 0; i < swaps.length; i++) {
      var el = swaps[i];
      if (!el.hasAttribute("data-usd")) el.setAttribute("data-usd", el.innerHTML);
      el.innerHTML = india ? el.getAttribute("data-inr") : el.getAttribute("data-usd");
    }
    var only = document.querySelectorAll("[data-only]");
    for (var j = 0; j < only.length; j++) only[j].hidden = only[j].getAttribute("data-only") !== (india ? "IN" : "XX");
    document.dispatchEvent(new CustomEvent("ew:country", { detail: { india: india } }));
  }

  window.ewCountryReady = new Promise(function (done) {
    if (saved === "IN" || saved === "XX") return done(saved === "IN");
    var timer = setTimeout(function () { done(guess); }, 2500);   // slow network: go with the guess
    fetch("/api/config").then(function (r) { return r.json(); }).then(function (c) {
      clearTimeout(timer);
      if (c && /^[A-Z]{2}$/.test(c.country || "")) {
        try { sessionStorage.setItem("ew_country", c.country === "IN" ? "IN" : "XX"); } catch (e) {}
        done(c.country === "IN");
      } else done(guess);
    }).catch(function () { clearTimeout(timer); done(guess); });
  });

  function start() {
    var first = saved ? saved === "IN" : guess;
    apply(first);
    window.ewCountryReady.then(function (india) { if (india !== first) apply(india); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
