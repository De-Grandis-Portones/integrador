import { getAuthHeader, clearStoredAuth } from './auth.js';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4010';

// Cuando el backend devuelve 401 (sesión vencida o credenciales inválidas), avisamos
// a la app para que vuelva a mostrar el login, sin importar desde qué llamada vino.
function notifyUnauthorized() {
  clearStoredAuth();
  window.dispatchEvent(new CustomEvent('arca-unauthorized'));
}

async function handle(res) {
  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('Sesión vencida o credenciales inválidas');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

export async function getJournals() {
  return handle(await fetch(`${API_URL}/api/comprobantes/journals`, { headers: getAuthHeader() }));
}

export async function searchAccounts(q) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  return handle(
    await fetch(`${API_URL}/api/comprobantes/accounts?${params.toString()}`, { headers: getAuthHeader() })
  );
}

export async function uploadCsv(file) {
  const formData = new FormData();
  formData.append('file', file);
  return handle(
    await fetch(`${API_URL}/api/comprobantes/upload`, { method: 'POST', headers: getAuthHeader(), body: formData })
  );
}

export async function cargarComprobantes(comprobantes) {
  return handle(
    await fetch(`${API_URL}/api/comprobantes/cargar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
      body: JSON.stringify({ comprobantes }),
    })
  );
}

export async function fetchRendiciones() {
  return handle(await fetch(`${API_URL}/api/rendiciones`, { headers: getAuthHeader() }));
}

export async function fetchRendicionDetalle(viajeId) {
  return handle(await fetch(`${API_URL}/api/rendiciones/${viajeId}`, { headers: getAuthHeader() }));
}

// Usado solo desde el formulario de login: prueba credenciales puntuales antes de
// guardarlas, sin depender de lo que ya esté (o no) en sessionStorage.
export async function verificarCredenciales(user, password) {
  const res = await fetch(`${API_URL}/api/comprobantes/journals`, {
    headers: { Authorization: `Basic ${btoa(`${user}:${password}`)}` },
  });
  return res.ok;
}
