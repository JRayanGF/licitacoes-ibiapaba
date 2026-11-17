// Proxy para a API publica do PNCP e do IBGE
const NOMES = ["Carnaubal","Croatá","Guaraciaba do Norte","Ibiapina","Ipu","Ipueiras","São Benedito","Tianguá","Ubajara","Viçosa do Ceará"];
const H = { "content-type": "application/json", "access-control-allow-origin": "*" };
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const ok = (b, c = 200) => ({ statusCode: c, headers: H, body: JSON.stringify(b) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, falhas) {
  for (let t = 1; t <= 4; t++) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0 licitacoes-ibiapaba" } });
      clearTimeout(to);
      console.log("PNCP", r.status, url.slice(0, 230));
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * t); continue; }
      if (!r.ok) { const b = (await r.text()).slice(0, 160); falhas.push("HTTP " + r.status + ": " + b); return { data: [], erro: r.status }; }
      const txt = await r.text();
      if (!txt) return { data: [] };
      try { return JSON.parse(txt); } catch { return { data: [] }; }
    } catch (e) {
      console.log("PNCP REDE", e.message);
      if (t === 4) { falhas.push("rede: " + e.message); return { data: [], erro: 0 }; }
      await sleep(1000 * t);
    }
  }
  falhas.push("PNCP pediu para esperar (429/5xx)"); return { data: [], erro: 429 };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const falhas = [];
  try {
    if (q.action === "municipios") {
      const lista = await getJson("https://servicodados.ibge.gov.br/api/v1/localidades/estados/CE/municipios", falhas);
      const alvo = NOMES.map(norm);
      const res = (Array.isArray(lista) ? lista : []).filter(m => alvo.includes(norm(m.nome)))
        .map(m => ({ nome: m.nome, ibge: String(m.id) })).sort((a, b) => a.nome.localeCompare(b.nome));
      return ok(res);
    }
    const ibges = (q.ibge || "").split(",").filter(Boolean);
    const mods = (q.modalidades || "4,5,6,7,8,9,12").split(",").filter(Boolean);
    const modo = q.modo === "publicacao" ? "publicacao" : "proposta";
    const hoje = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dF = (q.dataFinal || hoje).replace(/-/g, "");
    const dI = (q.dataInicial || dF).replace(/-/g, "");

    const buscar = async (ibge, mod) => {
      const out = []; let status = 200;
      for (let p = 1; p <= 40; p++) {
        const u = new URL(`https://pncp.gov.br/api/consulta/v1/contratacoes/${modo}`);
        u.searchParams.set("dataFinal", dF);
        if (modo === "publicacao") u.searchParams.set("dataInicial", dI);
        if (mod) u.searchParams.set("codigoModalidadeContratacao", mod);
        u.searchParams.set("codigoMunicipioIbge", ibge);
        u.searchParams.set("pagina", p);
        u.searchParams.set("tamanhoPagina", 50);
        const tmp = [];
        const j = await getJson(u.toString(), tmp);
        if (j.erro) { status = j.erro; tmp.forEach(x => falhas.push(x)); break; }
        (j.data || []).forEach(x => out.push(x));
        if (!j.totalPaginas || p >= j.totalPaginas) break;
        await sleep(250);
      }
      return { out, status };
    };

    const tarefas = ibges.map(ibge => async () => {
      if (modo === "proposta") {            // tenta sem modalidade (1 consulta por cidade)
        const r = await buscar(ibge, "");
        if (!r.status || r.status === 200) return r.out;
        if (r.status !== 400) return r.out;
      }
      const acc = [];                       // com modalidade (obrigatoria em "publicacao")
      for (const m of mods) { acc.push(...(await buscar(ibge, m)).out); await sleep(200); }
      return acc;
    });
    const res = []; let i = 0;
    await Promise.all(Array.from({ length: 3 }, async () => { while (i < tarefas.length) { const k = i++; res.push(await tarefas[k]()); } }));

    const vistos = new Set();
    const itens = res.flat().filter(x => !vistos.has(x.numeroControlePNCP) && vistos.add(x.numeroControlePNCP)).map(x => ({
      id: x.numeroControlePNCP, objeto: x.objetoCompra, orgao: x.orgaoEntidade?.razaoSocial,
      municipio: x.unidadeOrgao?.municipioNome, modalidade: x.modalidadeNome, modalidadeId: String(x.modalidadeId ?? ""),
      situacao: x.situacaoCompraNome, valor: x.valorTotalHomologado || x.valorTotalEstimado,
      publicacao: x.dataPublicacaoPncp, encerramento: x.dataEncerramentoProposta,
      link: x.orgaoEntidade?.cnpj ? `https://pncp.gov.br/app/editais/${x.orgaoEntidade.cnpj}/${x.anoCompra}/${x.sequencialCompra}` : null
    }));
    console.log("RESUMO total=" + itens.length + " falhas=" + JSON.stringify([...new Set(falhas)]));
    return ok({ total: itens.length, itens, falhas: [...new Set(falhas)] });
  } catch (e) {
    return ok({ erro: String(e) }, 500);
  }
};
