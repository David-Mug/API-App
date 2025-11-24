const els = {
  med: document.getElementById('medInput'),
  loc: document.getElementById('locInput'),
  radius: document.getElementById('radiusInput'),
  sort: document.getElementById('sortSelect'),
  priceMin: document.getElementById('priceMin'),
  priceMax: document.getElementById('priceMax'),
  stock: document.getElementById('stockSelect'),
  searchBtn: document.getElementById('searchBtn'),
  error: document.getElementById('errorBar'),
  loading: document.getElementById('loading'),
  meta: document.getElementById('meta'),
  results: document.getElementById('results'),
};

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove('hidden');
}
function clearError() {
  els.error.textContent = '';
  els.error.classList.add('hidden');
}
function setLoading(flag) {
  if (flag) els.loading.classList.remove('hidden');
  else els.loading.classList.add('hidden');
}

function pharmacyCard(item) {
  const stockClass = item.availability === 'in_stock' ? 'in' : item.availability === 'low_stock' ? 'low' : 'out';
  const dist = item.distance_km != null ? `${item.distance_km} km` : '—';
  const phone = item.phone || 'N/A';
  return `
    <article class="card">
      <h3 class="title">${escapeHtml(item.name)}</h3>
      <div class="meta">${escapeHtml(item.address || 'Address unavailable')}</div>
      <div class="meta">Distance: ${dist} · Phone: ${escapeHtml(phone)}</div>
      <div class="meta">
        <span class="badge price">$${item.price_usd.toFixed(2)}</span>
        <span class="badge stock ${stockClass}">${item.availability.replace('_', ' ')}</span>
      </div>
    </article>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>\"]+/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[s]));
}

function renderMeta(meta) {
  els.meta.classList.remove('hidden');
  els.meta.innerHTML = `
    <div>Medicine: <strong>${escapeHtml(meta.med.name)}</strong> (RxCUI ${meta.med.rxcui})</div>
    <div>Location: <strong>${escapeHtml(meta.location.text)}</strong></div>
    <div>Results: <strong>${meta.total}</strong></div>
  `;
}

function renderResults(items) {
  if (!items || items.length === 0) {
    els.results.innerHTML = '<p>No pharmacies found. Try adjusting filters or radius.</p>';
    return;
  }
  els.results.innerHTML = items.map(pharmacyCard).join('');
}

async function performSearch() {
  clearError();
  setLoading(true);
  try {
    const params = new URLSearchParams();
    params.set('med', els.med.value.trim());
    params.set('location', els.loc.value.trim());
    params.set('radius_km', String(Math.max(1, Math.min(50, Number(els.radius.value) || 10))));
    params.set('sort', els.sort.value);
    if (els.priceMin.value) params.set('price_min', String(Number(els.priceMin.value)));
    if (els.priceMax.value) params.set('price_max', String(Number(els.priceMax.value)));
    params.set('stock', els.stock.value);

    const res = await fetch(`/api/search?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) {
      if (data.suggestions && data.suggestions.length) {
        showError(`${data.error}. Did you mean: ${data.suggestions.slice(0, 5).join(', ')}?`);
      } else {
        showError(data.error || 'Request failed');
      }
      return;
    }
    renderMeta(data);
    renderResults(data.items);
  } catch (err) {
    showError(err.message || 'Unexpected error');
  } finally {
    setLoading(false);
  }
}

function init() {
  els.searchBtn.addEventListener('click', performSearch);
  // Enter key triggers search for convenience
  [els.med, els.loc, els.radius].forEach(el => el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performSearch();
  }));
}

init();