(async () => {
  try {
    await window.magpie.ready;
    const options = await magpie.options.get();
    location.replace(magpie.service || `http://127.0.0.1:${options.settingsPort || 38418}/`);
  } catch (error) { document.getElementById('status').textContent = error.message; }
})();
