import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Warmkey } from "../target/types/warmkey";
import { SystemProgram, PublicKey } from '@solana/web3.js';
import { expect } from "chai";
const {createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer} = require("@solana/spl-token");

// Sleep function to introduce delay
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("warmkey", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.warmkey as Program<Warmkey>;

  let senderKeypair: anchor.web3.Keypair;
  let merchantAcc: PublicKey;
  let bump: number;


  it("register", async () => {

    senderKeypair = anchor.web3.Keypair.generate();

    [merchantAcc, bump] = await PublicKey.findProgramAddress(
      [Buffer.from('merchant'), senderKeypair.publicKey.toBuffer()],
      program.programId
    );

    // Fund the sender account to cover for transactions (if necessary)
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(senderKeypair.publicKey, anchor.web3.LAMPORTS_PER_SOL)
    );

    const regTx = await program.methods
      .register()
      .accounts({
        senderAcc: senderKeypair.publicKey,
        merchantAcc: merchantAcc, // Merchant account (PDA)
        systemProgram: SystemProgram.programId,
      })
      .signers([senderKeypair])
      .rpc();

    console.log('register tx:', regTx);
    await sleep(5000);
    const regTxDetails = await program.provider.connection.getTransaction(regTx, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    const logs = regTxDetails?.meta?.logMessages || null;
    if (!logs) {
      throw new Error('register log not found!');
    }
    console.log("register log:", logs);
    expect(logs.includes(`Program log: merchant's account: ${merchantAcc.toBase58()}`)).to.be.true;

    const viewMerchantAcc = await provider.connection.getAccountInfo(merchantAcc);
    if (viewMerchantAcc === null) {
      throw new Error('merchant account does not exist!');
    }
    console.log('view merchant acc:', viewMerchantAcc);

    expect(viewMerchantAcc.owner.toBase58()).to.equal(program.programId.toBase58(), "merchant account's owner must be deployed program address");

    let decodedData = await program.account.merchantAcc.fetch(merchantAcc);
    console.log("merchant account data:", decodedData);

    expect(decodedData.user.toBase58()).to.equal(senderKeypair.publicKey.toBase58());

    // Create the mint (original token, 9 decimals)
    
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer,                  // fee payer
      provider.wallet.publicKey,        // mint authority
      provider.wallet.publicKey,        // freeze authority
      9                        // decimals
    );
    console.log("new token mint:", mint.toBase58());

    const tableId = 12345678901234567890n; // Example u128 for table_id
    const recordId = 98765432109876543210n; // Example u128 for record_id

    const tableIdBytes = Buffer.alloc(16);
    const recordIdBytes = Buffer.alloc(16);
    tableIdBytes.writeBigUInt64BE(BigInt(tableId >> 64n)); // Top 64 bits
    recordIdBytes.writeBigUInt64BE(BigInt(recordId >> 64n)); // Top 64 bits

    let depositAcc: PublicKey;
    let depositAccBump: number;
    [depositAcc, depositAccBump] = await PublicKey.findProgramAddress(
      [Buffer.from('deposit'), merchantAcc.toBuffer(), tableIdBytes, recordIdBytes],
      program.programId
    );
    
    console.log("deposit account:", depositAcc.toBase58());

    const depositAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet,
      mint,       // the token mint
      depositAcc  // token owner
    );

    console.log("deposit ata:", depositAta);
    
  });

});
