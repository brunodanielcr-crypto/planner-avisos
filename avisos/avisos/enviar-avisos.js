/*
 * Planner da Família — relógio de avisos (versão 3.0)
 * Roda a cada 5 minutos no GitHub Actions. Lê no Firestore os itens com aviso, vê quais
 * avisos venceram desde a última rodada e manda a notificação para os aparelhos cadastrados.
 * A regra de datas é a mesma do app (repetições, "só esta vez", dia 31 em meses curtos).
 */
const AREAS = {
  familiar: { nome: 'Familiar', ic: '🏠' },
  pessoal: { nome: 'Pessoal', ic: '🌱' },
  profissional: { nome: 'Profissional', ic: '💼' }
};
const AVISO_HORA = '08:00';
const DSL = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/* ---------- datas (horário de Brasília: o workflow define TZ=America/Sao_Paulo) ---------- */
const pad = n => String(n).padStart(2, '0');
const key = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = k => { const a = k.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2] || 1); };
const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return key(d); };

/* igual ao occurs() do app */
function occurs(it, dk) {
  if ((it.kind || 'item') !== 'item' || it.tipo === 'lembranca' || it.tipo === 'pendencia' || !it.data) return false;
  if (dk < it.data) return false;
  if (it.ate && dk > it.ate) return false;
  if (it.exc && it.exc.indexOf(dk) >= 0) return false;
  const r = it.rep || 'nao';
  if (r === 'nao') return dk === it.data;
  if (r === 'diaria') return true;
  const d = parse(dk), s = parse(it.data);
  if (r === 'semanal') { const ds = (it.dias && it.dias.length) ? it.dias : [s.getDay()]; return ds.indexOf(d.getDay()) >= 0; }
  const ult = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  if (r === 'mensal') return d.getDate() === Math.min(s.getDate(), ult);
  if (r === 'anual') return d.getMonth() === s.getMonth() && d.getDate() === Math.min(s.getDate(), ult);
  return false;
}
function baseTime(it, dk) { const p = (it.hora || AVISO_HORA).split(':').map(Number); const d = parse(dk); d.setHours(p[0], p[1] || 0, 0, 0); return d.getTime(); }
/* igual ao alertsBetween() do app */
function alertsBetween(itens, a, b) {
  const out = [];
  itens.forEach(it => {
    if (!it.avisos || !it.avisos.length || it.tipo === 'nota' || it.tipo === 'lembranca' || it.tipo === 'pendencia') return;
    const mx = Math.max.apply(null, it.avisos);
    let dk = key(new Date(a - 86400000)); const end = key(new Date(b + mx * 60000 + 86400000));
    for (let g = 0; dk <= end && g < 400; g++, dk = addDays(dk, 1)) {
      if (!occurs(it, dk)) continue;
      if (it.tipo === 'tarefa' && it.feito && it.feito[dk]) continue;
      const bt = baseTime(it, dk);
      it.avisos.forEach(m => { const at = bt - m * 60000; if (at >= a && at <= b && at >= (it.mod || 0)) out.push({ it, dk, m, at, bt, k: it.id + '|' + dk + '|' + m }); });
    }
  });
  return out.sort((x, y) => x.at - y.at);
}
function quando(al, now) {
  const hasHora = !!al.it.hora, diff = al.bt - now, dk = al.dk, t = key(new Date(now));
  const hh = hasHora ? ' às ' + al.it.hora : '';
  if (hasHora && Math.abs(diff) < 90000) return 'Agora';
  if (hasHora && diff > 0 && diff < 3600000) return 'Em ' + Math.round(diff / 60000) + ' min' + hh;
  if (dk === t) return 'Hoje' + hh;
  if (dk === addDays(t, 1)) return 'Amanhã' + hh;
  const d = parse(dk); return DSL[d.getDay()] + ', ' + d.getDate() + ' de ' + MS[d.getMonth()] + hh;
}

/* ---------- envio ---------- */
async function main() {
  const admin = require('firebase-admin');
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('Falta o segredo FIREBASE_SERVICE_ACCOUNT no GitHub (Settings → Secrets and variables → Actions).');
  let sa; try { sa = JSON.parse(raw); } catch (e) { throw new Error('O segredo FIREBASE_SERVICE_ACCOUNT não é um JSON válido. Cole o arquivo .json inteiro, do { até o }.'); }
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  const db = admin.firestore();
  console.log('Conectado ao Firebase.');

  const now = Date.now();
  const sisRef = db.doc('sistema/avisos');
  const sis = await sisRef.get();
  const ultimo = sis.exists && sis.data().ultimo ? sis.data().ultimo : now - 15 * 60000;
  // janela desde a última rodada (no máximo 2 h para trás, caso o GitHub atrase)
  const de = Math.max(ultimo, now - 120 * 60000) - 60000, ate = now;

  const cfgRef = db.doc('config/familia');
  const cfgSnap = await cfgRef.get();
  if (!cfgSnap.exists) { console.log('A família ainda não foi criada no app.'); return; }
  const cfg = cfgSnap.data();
  const uids = Object.keys(cfg.pessoas || {});

  // aparelhos cadastrados de cada pessoa
  const tokens = {}; const testes = [];
  for (const u of uids) {
    tokens[u] = [];
    (await db.collection('users').doc(u).collection('tokens').get()).forEach(d => {
      const x = d.data(); if (!x.token) return;
      tokens[u].push({ ref: d.ref, token: x.token });
      if (x.teste && x.teste > (x.testeEnviado || 0)) testes.push({ ref: d.ref, token: x.token, u });
    });
  }
  // o registro do GitHub é público em repositório público: só números, nunca nomes ou títulos
  console.log('Pessoas na família:', uids.length, '| aparelhos cadastrados:', uids.map(u => tokens[u].length).join(' + ') || '0');

  async function enviar(lista, data) {
    if (!lista.length) return 0;
    const res = await admin.messaging().sendEachForMulticast({
      tokens: lista.map(t => t.token),
      data,
      webpush: { headers: { Urgency: 'high', TTL: '3600' } }
    });
    res.responses.forEach((r, i) => {
      if (r.success) return;
      const c = r.error && r.error.code;
      console.log('Falha no envio para um aparelho:', c);
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token' || c === 'messaging/invalid-argument')
        lista[i].ref.delete().catch(() => {});
    });
    return res.successCount;
  }

  // testes pedidos pelo app (Ajustes → Testar pelo servidor)
  for (const t of testes) {
    const n = await enviar([t], { title: '🏠 Planner · teste do servidor', body: 'O relógio de avisos está funcionando. Os avisos vão chegar assim.', url: '/', tag: 'teste-servidor', tarefa: '0' });
    await t.ref.set({ testeEnviado: now }, { merge: true });
    console.log('Teste do servidor:', n ? 'entregue ao Firebase' : 'falhou');
  }

  const itens = [];
  (await db.collection('familia').where('temAviso', '==', true).get()).forEach(d => itens.push({ ...d.data(), id: d.id, _dest: 'todos' }));
  for (const u of uids) {
    (await db.collection('users').doc(u).collection('itens').where('temAviso', '==', true).get()).forEach(d => itens.push({ ...d.data(), id: d.id, _dest: u }));
  }
  const avisos = alertsBetween(itens, de, ate);
  console.log(`${itens.length} itens com aviso, ${avisos.length} para enviar agora.`);

  for (const al of avisos) {
    // marca como enviado; se já existe, outra rodada já mandou
    try { await db.collection('enviados').doc(al.k.replace(/\//g, '_')).create({ em: now }); } catch (e) { continue; }
    const dest = al.it._dest === 'todos' ? uids : [al.it._dest];
    const lista = dest.flatMap(u => tokens[u] || []);
    if (!lista.length) { console.log('Um aviso ficou sem aparelho cadastrado para receber.'); continue; }
    const area = AREAS[al.it.area] || AREAS.familiar;
    const body = [quando(al, now), al.it.local, al.it.cat].filter(Boolean).join(' · ');
    const n = await enviar(lista, {
      title: area.ic + ' ' + al.it.titulo,
      body,
      url: `/?d=${al.dk}&item=${encodeURIComponent(al.it.id)}`,
      tag: al.k,
      tarefa: al.it.tipo === 'tarefa' ? '1' : '0'
    });
    console.log(`Aviso enviado para ${n} de ${lista.length} aparelho(s).`);
  }

  await sisRef.set({ ultimo: now }, { merge: true });
  await cfgRef.set({ relogio: now }, { merge: true });   // o app mostra "última rodada" em Ajustes

  // limpeza: registros de envio com mais de 10 dias
  const velhos = await db.collection('enviados').where('em', '<', now - 10 * 86400000).limit(300).get();
  if (!velhos.empty) { const b = db.batch(); velhos.forEach(d => b.delete(d.ref)); await b.commit(); }
}

module.exports = { occurs, alertsBetween, quando };
if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error('ERRO:', e.message || e); process.exit(1); });
