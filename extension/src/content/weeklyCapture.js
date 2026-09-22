/* A read-only bridge for the popup. No Yahoo buttons are clicked. */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== "CAPTURE_WEEKLY_PAGE") return;
  import(chrome.runtime.getURL("src/lib/weeklyImport.js"))
    .then(({ parseWeeklyPage }) => parseWeeklyPage(document, { ...message.options, url: location.href }))
    .then((snapshot) => respond({ ok: true, snapshot }))
    .catch((err) => respond({ ok: false, error: err.message }));
  return true;
});
