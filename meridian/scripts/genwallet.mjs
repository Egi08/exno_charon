import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
const kp = Keypair.generate();
console.log('Public key (address):', kp.publicKey.toBase58());
console.log('Private key (base58 — paste ke .env WALLET_PRIVATE_KEY):');
console.log(bs58.encode(kp.secretKey));
