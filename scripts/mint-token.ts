const anchor = require("@coral-xyz/anchor");
const {createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer} = require("@solana/spl-token");
const {Connection, Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } = require("@solana/web3.js");
const fs = require('fs');

const main = async () => {
	const connection = new Connection("http://127.0.0.1:8899", "confirmed");
	const wallet  = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/ubuntu/.config/solana/id.json", "utf-8"))));	
	const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(wallet), {});
	anchor.setProvider(provider);
	
	const balance = await connection.getBalance(wallet.publicKey);
    const balanceInSol = balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
    console.log(`Balance: ${balanceInSol} SOL`);
		
	// Airdrop SOL to payer wallet
	//const airdropSig = await connection.requestAirdrop(wallet.publicKey, LAMPORTS_PER_SOL * 5);
	//await connection.confirmTransaction(airdropSig);
	//console.log("Airdropped SOL to:", wallet.publicKey.toBase58());
	
	// Create the mint (original token, 9 decimals)
	const mint = await createMint(
		connection,
		wallet,                  // fee payer
		wallet.publicKey,        // mint authority
		wallet.publicKey,        // freeze authority
		9                        // decimals
	);
	console.log("New token mint:", mint.toBase58());
	
	/*
	const mint = new PublicKey("6XiVDQkHM93YKojvn88UUUuPxPdNgMn5DPnhMcQjnUed");

	// Create or get associated token account for the user (can be another user)
	const userTokenAccount = await getOrCreateAssociatedTokenAccount(
		connection,
		wallet,
		mint,                    // the token mint
		wallet.publicKey         // token owner
	);

	console.log("User token account:", userTokenAccount.address.toBase58());
	const balance = await connection.getBalance(userTokenAccount.address);
    const balanceInSol = balance / LAMPORTS_PER_SOL; // Convert lamports to SOL
    console.log(`  SOL Balance: ${balanceInSol}`);
	
	// Mint 100 tokens (10^9 is 1 token because of 9 decimals)
	/*
	const mintAmount = 100 * 10 ** 9;
	await mintTo(
		connection,
		wallet,                 // fee payer
		mint,
		userTokenAccount.address,
		wallet,                 // mint authority
		mintAmount
	);
	*/
	

	// Fetch and print balance
	
	const accountInfo = await getAccount(connection, userTokenAccount.address);
	console.log("  token balance:", Number(accountInfo.amount) / 10 ** 9);
	
	// test send to non-ATA account
	try {
		recipientTokenAccount = new PublicKey("mmkyprqAN3ukTQF78ck8F9K5UfN8t9qQLet8RRVTcaC");
		const signature = await transfer(
		  connection,
		  wallet, //payer
		  userTokenAccount.address, //source account
		  recipientTokenAccount, // destination account
		  wallet.publicKey, //owner of source account
		  1 * 10 ** 9 //transfer amount
		);

		console.log("Transfer signature:", signature);
	} catch (e) {
		console.log("----- error: -----");
		console.log(e.message);
	}

};

main();