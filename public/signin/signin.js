const form = document.getElementById('signin');
const kludasVieta = document.getElementById('loginError');
 
// Ja jau esam pieslēgušies, uzreiz uz galveno lapu
fetch('/api/me').then((r) => {
  if (r.ok) window.location.href = '../index.html';
});
 
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  kludasVieta.textContent = '';
 
  const lietotajvards = document.getElementById('username').value.trim();
  const parole = document.getElementById('password').value;
 
  if (!lietotajvards || !parole) {
    kludasVieta.textContent = 'Ievadiet lietotājvārdu un paroli';
    return;
  }
 
  try {
    const atbilde = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lietotajvards, parole }),
    });
    const dati = await atbilde.json().catch(() => ({}));
 
    if (!atbilde.ok) {
      kludasVieta.textContent = dati.kluda || 'Radās kļūda';
      return;
    }
    window.location.href = '../index.html';
  } catch {
    kludasVieta.textContent = 'Nav savienojuma ar serveri';
  }
});