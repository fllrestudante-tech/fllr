// Escrita atômica de arquivo -- grava num .tmp no mesmo diretório do destino
// (rename entre filesystems diferentes não é atômico) e só então troca pelo
// arquivo final via fs.renameSync. Existe porque todo write de estado JSON
// deste repo (data/state.json, runtime/processes/state.json, etc.) usava
// fs.writeFileSync direto -- uma interrupção no meio da escrita (queda de
// energia, processo morto à força) deixa o arquivo truncado/inválido. `fs`
// é injetável pra permitir testar o caso "escrita falha no meio" sem
// depender de matar o processo de verdade.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function atomicWriteFileSync(filePath, data, { fsImpl = fs } = {}) {
  const dir = path.dirname(filePath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fsImpl.writeFileSync(tmpPath, data);
  fsImpl.renameSync(tmpPath, filePath);
}

function atomicWriteJsonSync(filePath, obj, opts = {}) {
  atomicWriteFileSync(filePath, JSON.stringify(obj, null, 2), opts);
}

module.exports = { atomicWriteFileSync, atomicWriteJsonSync };
