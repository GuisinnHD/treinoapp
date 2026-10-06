// Função serverless da Vercel: guarda os dados no Upstash Redis (Marketplace da Vercel).
// API genérica: o corpo diz o "tipo" do registro (dia, cfg, treino, rotina).
// Para acrescentar outro tipo no futuro, basta uma linha na tabela TIPOS.
const crypto = require("crypto");

// APP_SENHA aceita vários códigos separados por vírgula: um por pessoa.
// O 1º código é o seu; cada um dos outros tem a sua própria área no banco.
// Os prefixos são os mesmos do app de água antigo, então os dados antigos continuam valendo.
const CODIGOS = (process.env.APP_SENHA || "").split(",").map((s) => s.trim()).filter(Boolean);
function prefixoDe(codigo) {
  const i = CODIGOS.indexOf(codigo);
  if (i < 0) return null;
  return i === 0 ? "agua" : "agua:" + crypto.createHash("sha256").update(codigo).digest("hex").slice(0, 16);
}

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// HGETALL volta como lista [campo, valor, campo, valor...] (ou já como objeto)
function pares(res, converter) {
  const out = {};
  if (Array.isArray(res)) for (let i = 0; i < res.length; i += 2) out[res[i]] = converter(res[i + 1]);
  else if (res && typeof res === "object") for (const k of Object.keys(res)) out[k] = converter(res[k]);
  return out;
}
const lerJSON = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; } };

// ---------- Validação (tudo é conferido aqui, nunca confiamos no app) ----------
const ID = /^[a-z0-9_-]{1,40}$/;
const ehObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const texto = (s, max, min) => typeof s === "string" && s.trim().length >= min && s.length <= max;
const inteiro = (x, max, padrao) => (x === undefined ? padrao : Number.isInteger(x) && x >= 0 && x <= max ? x : null);
function dataValida(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return a >= 2000 && a <= 2100 && dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Exercício. Numa rotina: modelo (com "i" = como fazer). Num treino: com as séries feitas ("s").
// m = "r" (repetições) ou "t" (tempo em segundos); ns = nº de séries; v = meta por série;
// d = descanso em segundos; tot = meta total (ex.: 100 flexões).
function vEx(e, rotina) {
  if (!ehObj(e) || !texto(e.n, 60, 1)) return { erro: "Nome de exercício inválido (1 a 60 letras)" };
  if (e.m !== "r" && e.m !== "t") return { erro: "Tipo do exercício inválido" };
  const ns = inteiro(e.ns, 20, 0), v = inteiro(e.v, 7200, 0), d = inteiro(e.d, 600, 90), tot = inteiro(e.tot, 10000, 0);
  if ([ns, v, d, tot].includes(null)) return { erro: "Metas do exercício inválidas" };
  const o = { n: e.n.trim(), m: e.m, ns, v, d, tot };
  if (rotina) {
    const i = e.i === undefined ? "" : e.i;
    if (!texto(i, 500, 0)) return { erro: "Texto do 'como fazer' grande demais (máx. 500 letras)" };
    o.i = i.trim();
  } else {
    if (!Array.isArray(e.s) || e.s.length > 40) return { erro: "Lista de séries inválida (máx. 40)" };
    if (!e.s.every((x) => ehObj(x) && Number.isInteger(x.v) && x.v >= 1 && x.v <= 7200)) return { erro: "Valor de série inválido (1 a 7200)" };
    o.s = e.s.map((x) => ({ v: x.v }));
  }
  return { valor: o };
}
function vLista(lista, rotina) {
  if (!Array.isArray(lista) || lista.length > 30) return { erro: "Lista de exercícios inválida (máx. 30)" };
  const ex = [];
  for (const e of lista) { const r = vEx(e, rotina); if (r.erro) return r; ex.push(r.valor); }
  return { valor: ex };
}

function vDia(b) {
  const v = b.valor;
  if (!dataValida(b.data)) return { erro: "Data inválida" };
  if (!ehObj(v) || !Array.isArray(v.a) || v.a.length > 200 || !v.a.every((n) => Number.isInteger(n) && n > 0 && n <= 5000) || typeof v.c !== "boolean") return { erro: "Dados do dia inválidos" };
  return { id: b.data, valor: { a: v.a, c: v.c } };
}
function vTreino(b) {
  const v = b.valor;
  if (typeof b.id !== "string" || !ID.test(b.id)) return { erro: "Identificador inválido" };
  if (!ehObj(v)) return { erro: "Treino inválido" };
  if (!dataValida(v.d)) return { erro: "Data inválida" };
  const r = v.r === undefined ? "" : v.r;
  if (!texto(r, 60, 0)) return { erro: "Nome da rotina inválido (máx. 60 letras)" };
  const ex = vLista(v.ex, false);
  if (ex.erro) return ex;
  return { id: b.id, valor: { d: v.d, r: r.trim(), f: v.f === true, x: v.x === true, ex: ex.valor } };
}
function vRotina(b) {
  const v = b.valor;
  if (typeof b.id !== "string" || !ID.test(b.id)) return { erro: "Identificador inválido" };
  if (!ehObj(v)) return { erro: "Rotina inválida" };
  const x = v.x === true;
  if (!texto(v.n, 60, x ? 0 : 1)) return { erro: "Nome da rotina inválido (1 a 60 letras)" };
  const ex = vLista(v.ex, true);
  if (ex.erro) return ex;
  return { id: b.id, valor: { n: v.n.trim(), x, ex: ex.valor } };
}
// Configurações: campos soltos no mesmo hash (meta e dose de água/creatina, descanso padrão)
function vCfg(b) {
  const meta = Number(b.meta), dose = Number(b.dose), desc = b.desc === undefined ? 90 : b.desc;
  if (!(meta >= 500 && meta <= 20000) || !(dose > 0 && dose <= 100)) return { erro: "Dados inválidos" };
  if (!Number.isInteger(desc) || desc < 0 || desc > 600) return { erro: "Descanso inválido (0 a 600 segundos)" };
  return { flat: { meta, dose, desc } };
}

// tipo -> { col: hash no Redis, val: validador, leitura: como converter na resposta }
const TIPOS = {
  dia: { col: "dias", val: vDia, ler: lerJSON },
  cfg: { col: "cfg", val: vCfg, ler: Number },
  treino: { col: "treinos", val: vTreino, ler: lerJSON },
  rotina: { col: "rotinas", val: vRotina, ler: lerJSON }
};

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!CODIGOS.length || !URL_ || !TOKEN) return res.status(500).json({ erro: "Servidor sem configuração (APP_SENHA ou banco)" });
  const p = prefixoDe(String(req.headers["x-senha"] || ""));
  if (!p) return res.status(401).json({ erro: "Código incorreto" });

  try {
    if (req.method === "GET") {
      const tipos = Object.values(TIPOS);
      const listas = await Promise.all(tipos.map((t) => redis(["HGETALL", `${p}:${t.col}`])));
      const out = {};
      tipos.forEach((t, i) => { out[t.col] = pares(listas[i], t.ler); });
      return res.status(200).json(out);
    }

    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = null; } }
      if (!ehObj(b)) return res.status(400).json({ erro: "Corpo da requisição inválido" });
      if (JSON.stringify(b).length > 30000) return res.status(400).json({ erro: "Dados grandes demais" });
      if (typeof b.tipo !== "string" || !Object.prototype.hasOwnProperty.call(TIPOS, b.tipo)) return res.status(400).json({ erro: "Tipo desconhecido" });
      const tipo = TIPOS[b.tipo];
      const r = tipo.val(b);
      if (r.erro) return res.status(400).json({ erro: r.erro });
      let t = Number(r.flat ? b.t : ehObj(b.valor) ? b.valor.t : undefined);
      if (!Number.isFinite(t) || t <= 0) t = Date.now();
      if (t > Date.now() + 864e5) return res.status(400).json({ erro: "Horário inválido" });
      t = Math.round(t);
      if (r.flat) await redis(["HSET", `${p}:${tipo.col}`, ...Object.entries({ ...r.flat, t }).flat()]);
      else await redis(["HSET", `${p}:${tipo.col}`, r.id, JSON.stringify({ ...r.valor, t })]);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ erro: "Método não permitido" });
  } catch (e) {
    return res.status(500).json({ erro: "Falha no banco de dados" });
  }
};
