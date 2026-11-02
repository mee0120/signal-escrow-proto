// SignalEscrow on BCH chipnet (testnet). Run on the VPS.
//   node chipnet.mjs keygen           create throwaway subscriber/provider keys in .env (chmod 600)
//   node chipnet.mjs status           show addresses, balances, escrow UTXOs
//   node chipnet.mjs deposit 50000    subscriber locks sats in the escrow
//   node chipnet.mjs charge "BUY ETH" provider charges one signal (escrow UTXO must be >= 6 blocks old)
//   node chipnet.mjs refund           subscriber takes everything back
// Private keys are only read from .env and are never printed.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import { secp256k1, hash160, generatePrivateKey, encodeLockingBytecodeP2pkh, encodeCashAddress, binToHex, hexToBin, sha256, utf8ToBin } from '@bitauth/libauth';

const PRICE = 10_000n, INTERVAL = 6n, MAX_FEE = 2_000n, FEE = 1_000n;
const ENV = new URL('./.env', import.meta.url);
const EXPLORER = 'https://chipnet.imaginary.cash/tx/';
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'keygen') {
  if (existsSync(ENV)) { console.log('.env already exists, not overwriting'); process.exit(1); }
  writeFileSync(ENV, `SUB_KEY=${binToHex(generatePrivateKey())}\nPROV_KEY=${binToHex(generatePrivateKey())}\n`);
  chmodSync(ENV, 0o600);
  console.log('keys written to .env (chmod 600). Run: node chipnet.mjs status');
  process.exit(0);
}

const env = Object.fromEntries(readFileSync(ENV, 'utf8').trim().split('\n').map(l => l.split('=')));
const w = (hex) => {
  const priv = hexToBin(hex), pub = secp256k1.derivePublicKeyCompressed(priv), pkh = hash160(pub);
  return { pub, pkh, lock: encodeLockingBytecodeP2pkh(pkh), sig: new SignatureTemplate(priv),
    address: encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address };
};
const sub = w(env.SUB_KEY), prov = w(env.PROV_KEY);
// Public chipnet Electrum servers (wss). The first one that answers is used.
// Override with CHIPNET_SERVER=host:port in .env if needed.
const SERVERS = [
  ...(env.CHIPNET_SERVER ? [env.CHIPNET_SERVER] : []),
  'chipnet.bch.ninja:50004', 'chipnet.imaginary.cash:50004', 'cbch.loping.net:62104', 'chipnet.c3-soft.com:64004',
];
// The socket library also throws connection errors outside our try/catch; ignore those here.
let lastSocketError = '';
process.on('unhandledRejection', (e) => { lastSocketError = String(e?.message ?? e); });
async function connect() {
  for (const s of SERVERS) {
    const [host, port] = s.split(':');
    const socket = new ElectrumWebSocket(host, { port: Number(port), timeoutInMilliSeconds: 8000 });
    const electrum = new ElectrumClient('SignalEscrow chipnet test', '1.5.0', socket);
    const p = new ElectrumNetworkProvider('chipnet', { electrum });
    try { await p.getBlockHeight(); console.log('server        :', s); return p; }
    catch (e) { console.log('server down   :', s, '-', (lastSocketError || e.message).slice(0, 80)); }
  }
  throw new Error('no chipnet server reachable');
}
const provider = await connect();
// Print only the rejection reason. CashScript's error also carries a Bitauth URI that embeds the private keys.
process.on('uncaughtException', (e) => { console.error('REJECTED:', (e.reason ?? e.message ?? String(e)).trim()); process.exit(1); });
const artifact = JSON.parse(readFileSync(new URL('./SignalEscrow.json', import.meta.url)));
const contract = new Contract(artifact, [sub.pkh, prov.pkh, PRICE, INTERVAL, MAX_FEE], { provider, addressType: 'p2sh32' });
const sum = (us) => us.reduce((a, u) => a + u.satoshis, 0n);
const done = (tx) => { console.log('txid:', tx.txid, '\n' + EXPLORER + tx.txid); };

if (cmd === 'status') {
  const [su, pu, eu] = await Promise.all([provider.getUtxos(sub.address), provider.getUtxos(prov.address), contract.getUtxos()]);
  console.log('block height  :', await provider.getBlockHeight());
  console.log('subscriber    :', sub.address, sum(su), 'sats');
  console.log('provider      :', prov.address, sum(pu), 'sats');
  console.log('escrow        :', contract.address);
  for (const u of eu) console.log('  escrow utxo :', u.txid + ':' + u.vout, u.satoshis, 'sats');
  console.log(`rules         : price ${PRICE} sats, at most once per ${INTERVAL} blocks, max fee ${MAX_FEE}`);
} else if (cmd === 'deposit') {
  const amount = BigInt(arg ?? '50000');
  const utxos = await provider.getUtxos(sub.address);
  const total = sum(utxos);
  if (total < amount + FEE) throw new Error(`subscriber has ${total} sats, needs ${amount + FEE}. Fund ${sub.address} from a chipnet faucet.`);
  const tb = new TransactionBuilder({ provider });
  for (const u of utxos) tb.addInput(u, sub.sig.unlockP2PKH());
  tb.addOutput({ to: contract.address, amount });
  const change = total - amount - FEE;
  if (change >= 1000n) tb.addOutput({ to: sub.address, amount: change });
  done(await tb.send());
} else if (cmd === 'charge') {
  const text = arg ?? 'BUY ETH';
  const hash = binToHex(sha256.hash(utf8ToBin(text)));
  const [u] = await contract.getUtxos();
  if (!u) throw new Error('escrow is empty');
  const tx = await new TransactionBuilder({ provider })
    .addInput(u, contract.unlock.charge(prov.pub, prov.sig, hash), { sequence: Number(INTERVAL) })
    .addOutput({ to: prov.address, amount: PRICE })
    .addOutput({ to: contract.address, amount: u.satoshis - PRICE - FEE })
    .addOpReturnOutput(['0x' + hash])
    .send();
  console.log('signal:', JSON.stringify(text), 'sha256:', hash);
  done(tx);
} else if (cmd === 'refund') {
  const utxos = await contract.getUtxos();
  if (!utxos.length) throw new Error('escrow is empty');
  const tb = new TransactionBuilder({ provider });
  for (const u of utxos) tb.addInput(u, contract.unlock.refund(sub.pub, sub.sig));
  tb.addOutput({ to: sub.address, amount: sum(utxos) - FEE });
  done(await tb.send());
} else {
  console.log('usage: node chipnet.mjs keygen|status|deposit <sats>|charge "<signal>"|refund');
}
process.exit(0);
