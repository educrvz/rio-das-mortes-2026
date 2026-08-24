(function () {
  'use strict';

  const CACHE_PREFIX = 'rio-das-mortes-google-';
  const PROGRESS_PREFIX = 'rio-das-mortes-google-user-notes-v1-offline-progress';
  const button = document.getElementById('reset-button');
  const status = document.getElementById('reset-status');

  async function deleteGoogleCaches() {
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX))
      .map(name => caches.delete(name)));
  }

  async function resetDownload() {
    button.disabled = true;
    button.textContent = 'APAGANDO DOWNLOAD ANTERIOR…';
    status.textContent = 'Aguarde. Não feche esta tela.';

    try {
      const expectedScope = new URL('./', location.href).href;
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations
        .filter(registration => registration.scope === expectedScope)
        .map(registration => registration.unregister()));

      await deleteGoogleCaches();

      // The old worker may finish one in-flight batch after unregistering.
      // Delete a second time after it has released the cache.
      await new Promise(resolve => setTimeout(resolve, 750));
      await deleteGoogleCaches();

      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      keys.filter(key => key?.startsWith(PROGRESS_PREFIX))
        .forEach(key => localStorage.removeItem(key));

      status.textContent = 'Download anterior apagado. Iniciando novamente…';
      location.replace(`index.html?fresh=${Date.now()}`);
    } catch (error) {
      status.textContent = 'Não foi possível apagar o download. Feche o Brave e tente novamente.';
      button.disabled = false;
      button.textContent = 'TENTAR APAGAR NOVAMENTE';
    }
  }

  button.addEventListener('click', resetDownload);
}());
