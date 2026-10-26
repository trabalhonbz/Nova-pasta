/* Adaptador que faz o `node:sqlite` responder como o D1 do Cloudflare.

   O D1 é SQLite, e o `node:sqlite` é o mesmo motor — o que muda é só a forma de
   chamar: o D1 usa `prepare(sql).bind(...).first()`, e o node usa
   `prepare(sql).get(...)`. Esta camada traduz, e com isso as consultas do Worker
   são exercitadas de verdade nos testes, incluindo as restrições CHECK, as
   chaves estrangeiras e os gatilhos do schema.

   O que ela NÃO reproduz: limites de tamanho de lote, latência e a cota diária
   de leituras do D1. Esses só aparecem na nuvem.
*/
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function lerSchema() {
  return fs.readFileSync(path.join(raiz, 'src', 'schema.sql'), 'utf8');
}

export function adaptarD1(db) {
  function preparar(sql) {
    const stmt = db.prepare(sql);
    let args = [];
    const api = {
      bind(...valores) {
        /* O D1 aceita null; o node:sqlite recusa undefined, que aparece quando
           um campo opcional não foi preenchido. */
        args = valores.map((valor) => (valor === undefined ? null : valor));
        return api;
      },
      first() {
        const linha = stmt.get(...args);
        return Promise.resolve(linha === undefined ? null : linha);
      },
      all() {
        return Promise.resolve({ results: stmt.all(...args) });
      },
      run() {
        const info = stmt.run(...args);
        return Promise.resolve({ meta: { changes: Number(info.changes || 0) } });
      },
      /* Usado pelo batch: executa sem devolver promessa, para que o lote inteiro
         rode dentro da mesma transação. */
      _executar() {
        const info = stmt.run(...args);
        return { meta: { changes: Number(info.changes || 0) } };
      }
    };
    return api;
  }

  return {
    prepare: preparar,
    /* O `batch` do D1 roda as instruções em ordem e numa transação: ou todas
       entram, ou nenhuma. Reproduzir isso importa, porque a sincronização conta
       com ele para não deixar pavimento sem a obra a que pertence. */
    batch(instrucoes) {
      db.exec('begin');
      try {
        const resultados = instrucoes.map((instrucao) => instrucao._executar());
        db.exec('commit');
        return Promise.resolve(resultados);
      } catch (falha) {
        db.exec('rollback');
        return Promise.reject(falha);
      }
    }
  };
}

/* Banco novo com o schema aplicado. Cada teste usa o seu, para que estado
   vazado de um caso não mascare erro em outro. */
export function bancoNovo() {
  const db = new DatabaseSync(':memory:');
  db.exec(lerSchema());
  return db;
}
