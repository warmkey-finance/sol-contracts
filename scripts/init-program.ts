const anchor = require("@coral-xyz/anchor");
const {createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer} = require("@solana/spl-token");
const {Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
const fs = require('fs');
 
const main = async () => {
	//const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
    const connection = new Connection("https://api.devnet.solana.com", "confirmed");

	const wallet  = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/ubuntu/.config/solana/id.json", "utf-8"))));	
	const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
	anchor.setProvider(provider);
	
	const balance = await connection.getBalance(wallet.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
    console.log(`Balance: ${balanceInSol} SOL`);

    const idl = JSON.parse(fs.readFileSync("target/idl/warmkey.json"));
    const program = new anchor.Program(idl, provider);

    [programAcc, bump] = await PublicKey.findProgramAddress(
        [Buffer.from('programstate'), provider.wallet.payer.publicKey.toBuffer()],
        program.programId
    );
    console.log("program stater:", programAcc.toBase58());

    let wkBeneficiary = new PublicKey("5W9kUdZMPk5gR6XiRVyri2cps1kJRY3b8eb6b76qYiEX");
    var tx = await program.methods
    .initProgram( wkBeneficiary )
    .accounts({
        programState: programAcc,
        signer: provider.wallet.payer.publicKey,
        systemProgram: SystemProgram.programId,
    })
    .transaction();

    const initProgTx = await sendAndConfirmTransaction(provider.connection, tx, [provider.wallet.payer], { commitment: "confirmed" });
    console.log('init program tx:', initProgTx);
                
};

main();