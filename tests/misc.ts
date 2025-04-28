import * as anchor from "@coral-xyz/anchor";
import { BN, BorshCoder,Program, AnchorError, EventParser } from "@coral-xyz/anchor";
import { Warmkey } from "../target/types/warmkey";
import { Keypair, SystemProgram, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY ,} from '@solana/web3.js';
import { expect } from "chai";
const {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, createMint, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer, AuthorityType, createSetAuthorityInstruction, createAssociatedTokenAccountInstruction,createApproveInstruction, } = require("@solana/spl-token");
import { Emit } from "../target/types/emit";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const getTxSize = (tx: Transaction, feePayer: PublicKey): number => {
	
	
	const LOW_VALUE = 127; // 0x7f
	const HIGH_VALUE = 16383; // 0x3fff
	const compactHeader = (n: number) => (n <= LOW_VALUE ? 1 : n <= HIGH_VALUE ? 2 : 3);
	const compactArraySize = (n: number, size: number) => compactHeader(n) + n * size;
	
	
	const feePayerPk = [feePayer.toBase58()];

	const signers = new Set<string>(feePayerPk);
	const accounts = new Set<string>(feePayerPk);

	const ixsSize = tx.instructions.reduce((acc, ix) => {
		ix.keys.forEach(({ pubkey, isSigner }) => {
			const pk = pubkey.toBase58();
			if (isSigner) signers.add(pk);
			accounts.add(pk);
		});

		accounts.add(ix.programId.toBase58());

		const nIndexes = ix.keys.length;
		const opaqueData = ix.data.length;

		return (
			acc +
			1 + // PID index
			compactArraySize(nIndexes, 1) +
			compactArraySize(opaqueData, 1)
		);
	}, 0);

	return (
		compactArraySize(signers.size, 64) + // signatures
		3 + // header
		compactArraySize(accounts.size, 32) + // accounts
		32 + // blockhash
		compactHeader(tx.instructions.length) + // instructions
		ixsSize
	);
}

function findAssociatedTokenAddress(
    walletAddress: PublicKey,
    tokenMintAddress: PublicKey
): PublicKey {
    return PublicKey.findProgramAddressSync(
        [
            walletAddress.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            tokenMintAddress.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    )[0];
}

describe("--- WARMKEY MISC ---", async () => {
	
	
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.env();
	anchor.setProvider(provider);
	const program = anchor.workspace.warmkey as Program<Warmkey>;

	let merchantWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
	let merchantTokenAccount;
	let merchantData: PublicKey;
	
	let bump: number;
	
	let wkBeneficiary: anchor.web3.Keypair = provider.wallet.payer;
	
	
	let mint;
	
	/*
	const programKeypair = Keypair.fromSecretKey(new Uint8Array(Object.values({"0":202,"1":188,"2":248,"3":59,"4":41,"5":255,"6":75,"7":31,"8":226,"9":117,"10":36,"11":213,"12":92,"13":113,"14":144,"15":59,"16":184,"17":165,"18":166,"19":191,"20":142,"21":232,"22":212,"23":116,"24":96,"25":23,"26":23,"27":91,"28":182,"29":210,"30":197,"31":224,"32":143,"33":202,"34":134,"35":59,"36":120,"37":218,"38":128,"39":194,"40":77,"41":135,"42":204,"43":21,"44":210,"45":25,"46":105,"47":253,"48":252,"49":244,"50":155,"51":56,"52":233,"53":0,"54":232,"55":28,"56":136,"57":222,"58":102,"59":116,"60":69,"61":162,"62":163,"63":100})));
	console.log("Program Stater:", programKeypair.publicKey.toBase58());
	*/
	
	let programAcc: PublicKey;
	
	before(async () => {
		
		console.log("provider wallet:", provider.wallet.publicKey.toBase58());
		console.log("program id:", program.programId.toBase58());
		
		// create new mint (original token, 9 decimals)
		mint = await createMint(
			provider.connection,
			provider.wallet.payer,    // fee payer
			provider.wallet.publicKey,// mint authority
			provider.wallet.publicKey,// freeze authority
			9                         // decimals
		);
		console.log("new token mint:", mint.toBase58());
		
		const block = await provider.connection.getLatestBlockhash();
		console.log("blockhash:", block.blockhash, "height:", block.lastValidBlockHeight);
		
		
		//===== setup merchant =====
		// fund sol to merchant wallet
		await provider.connection.confirmTransaction(
			await provider.connection.requestAirdrop(merchantWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * 1000)
		);
		
		// create merchant token account
		merchantTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,   // payer
			mint,                    // the token mint
			merchantWallet.publicKey // token owner
		);
		console.log("merchant token account:", merchantTokenAccount.address.toBase58());
		
		// fund 123 tokens to merchantTokenAccount
		const mintAmount = 123 * 10 ** 9;
		await mintTo(
			provider.connection,
			provider.wallet.payer,        // fee payer
			mint,
			merchantTokenAccount.address, //to
			provider.wallet,              // mint authority
			mintAmount
		);
		
		//===== setup program =====
		[programAcc, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('programstate'), provider.wallet.payer.publicKey.toBuffer()],
			program.programId
		);
		console.log("program stater:", programAcc.toBase58());
		var tx = await program.methods
			.initProgram( wkBeneficiary.publicKey )
			.accounts({
				programState: programAcc,
				signer: provider.wallet.payer.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
		
		//console.log("serialized:", tx.serialize()); // this will prompt error , say need recentblockhash and payer
		const initProgTx = await sendAndConfirmTransaction(provider.connection, tx, [provider.wallet.payer], { commitment: "confirmed" });
		console.log('init program tx:', initProgTx);

	});
	
	it("misc", async() => {
		
		var recipientWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		var recipientTokenAcc = await getAssociatedTokenAddress(mint, recipientWallet.publicKey);

		// fund sol to merchant wallet
		await provider.connection.confirmTransaction(
			await provider.connection.requestAirdrop(recipientWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * 1000)
		);

		var tx = await program.methods
		.createAta()
		.accounts({
			payer: recipientWallet.publicKey,
			tokenAccount: recipientTokenAcc,
			mint: mint,
			tokenProgram: TOKEN_PROGRAM_ID, 
			systemProgram: SystemProgram.programId,
			associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
			rent: SYSVAR_RENT_PUBKEY,
		})
		.transaction();
		
		const createAtaTx = await sendAndConfirmTransaction(provider.connection, tx, [recipientWallet], { commitment: "confirmed" });
		const createAtaTxDetails = await program.provider.connection.getTransaction(createAtaTx, {maxSupportedTransactionVersion: 0, commitment: "confirmed"});
	
		console.log('create token acc tx:', createAtaTx);
		console.log("tx size:", getTxSize(tx, recipientWallet.publicKey));
		console.log(createAtaTxDetails);

		return;
		
		let accountMetas = [];
		
		accountMetas.push({pubkey: provider.wallet.publicKey, isWritable: false, isSigner: false});
		accountMetas.push({pubkey: merchantWallet.publicKey, isWritable: false, isSigner: false});
		
		var balances = await program.methods.getSolBalances()
		.remainingAccounts(accountMetas)
		.view();
		console.log("sol balances:", balances);
		
		
		accountMetas = [];
		accountMetas.push({pubkey: merchantTokenAccount.address, isWritable: false, isSigner: false});
		
		var balances = await program.methods.getTokenBalances()
		.remainingAccounts(accountMetas)
		.view();
		console.log("token balances:", balances);
		
		return;
		
		var recipientWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		var recipientTokenAcc = await getAssociatedTokenAddress(mint, recipientWallet.publicKey);
		var thisAcc = await provider.connection.getAccountInfo(recipientTokenAcc);
		expect(thisAcc).to.be.null;
		
		var tx = await program.methods
			.createTokenAcc()
			.accounts({
				recipient: recipientTokenAcc,
				walletRecipient: recipientWallet.publicKey,
				signer: provider.wallet.payer.publicKey,
				associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
				mint: mint,
				tokenProgram: TOKEN_PROGRAM_ID, 
				systemProgram: SystemProgram.programId,
				rent: SYSVAR_RENT_PUBKEY,
			})
			.transaction();
		
		const createTokenAccTx = await sendAndConfirmTransaction(
			provider.connection, 
			tx, 
			[provider.wallet.payer],
			{ commitment: "confirmed" }
		);
		
		console.log('create token acc tx:', createTokenAccTx);
		console.log("tx size:", getTxSize(tx, provider.wallet.payer.publicKey));
		
		const createTokenAccTxDetails = await program.provider.connection.getTransaction(createTokenAccTx, {maxSupportedTransactionVersio: 0, commitment: "confirmed",});
		var logs = createTokenAccTxDetails?.meta?.logMessages || null;
		//console.log(logs);
		
		var thisAcc = await provider.connection.getAccountInfo(recipientTokenAcc);
		expect(thisAcc).to.not.be.null;
		
		// read version
		const version = await program.methods.version().view();
		console.log("Program Version:", version);
		
		//===== check tx fees ====
		
		var beforeBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		var tx = await program.methods
			.checkTxFees( )
			.transaction()
			
		const checkFeesTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('check fees tx:', checkFeesTx);	
		console.log("tx size:", getTxSize(tx, provider.wallet.payer.publicKey));
		
		var afterBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		
		console.log("  SOL changes:", (beforeBalance - afterBalance) / LAMPORTS_PER_SOL);
		
		const checkTxFeesDetails = await program.provider.connection.getTransaction(checkFeesTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		//console.log(checkTxFeesDetails);
		return;
		
	});
	
	
	it("fundout2", async () => {
		return;
		let depositWallets = [anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()];
		let depositTokenAccounts = [];
		
		for(var x in depositWallets) {
			let depositWallet = depositWallets[x];
			// fund sol to deposit wallet
			await provider.connection.confirmTransaction(
				await provider.connection.requestAirdrop(depositWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL)
			);
			
			console.log("deposit wallet:", depositWallet.publicKey.toBase58());

			// create deposit token account
			let created = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,  // payer
				mint,                   // the token mint
				depositWallet.publicKey // token owner
			);
			
			depositTokenAccounts.push(created);
			var depositTokenAccount = depositTokenAccounts[depositTokenAccounts.length - 1];
			
			console.log("deposit token account:", depositTokenAccount.address.toBase58());
			
			// Mint 100 tokens (10^9) to DTA
			const mintAmount = 100 * 10 ** 9;
			await mintTo(
				provider.connection,
				provider.wallet.payer, // fee payer
				mint,
				depositTokenAccount.address,
				provider.wallet, // mint authority
				mintAmount
			);
			
			var beforeDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
			
			// change account owner to merchant pda
			var tx = new Transaction().add(
				createSetAuthorityInstruction(
					depositTokenAccount.address, // token account
					depositWallet.publicKey,     // current auth
					AuthorityType.AccountOwner,  // authority type
					merchantData,                 // new auth
					[],
					TOKEN_PROGRAM_ID,            // token program
				),
			);
			const setAuthTx = await provider.sendAndConfirm(tx, [depositWallet]);
			console.log('set auth tx:', setAuthTx);
		
			var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
			expect(afterDepTokenAcc.owner.toBase58()).to.equal(merchantData.toBase58(), "token account's owner now must be merchant acc (PDA)");
		}
		
		// fundout
		var getMerchantData = await program.account.merchantData.fetch(merchantData);
		var beforeWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address);
		var beforeRef = await getAccount(provider.connection, refTokenAccount.address);
		
		//1 deposit account = 45354 CU, 2 deposit account = 61764
		//1 deposit account = 23968 CU, 2 deposit account = 39094
		
		
		var tx = await program.methods
			.depFundout2( 0/*merchant beneficiary index*/ )
			
			.accounts({
				depTokenAcc1: depositTokenAccounts[0].address,
				depTokenAcc2: depositTokenAccounts[1].address,
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				referral: refTokenAccount.address,
				beneficiaryAcc: merchantTokenAccount.address,
				wkBeneficiary: wkBeneficiaryTokenAcc.address,
				tokenProgram: TOKEN_PROGRAM_ID, 
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const fundoutTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('fundout tx:', fundoutTx);
		console.log("tx size:", getTxSize(tx, merchantWallet.publicKey));
		const fundoutTxDetails = await program.provider.connection.getTransaction(fundoutTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		
		console.log(fundoutTxDetails);
		
		/*
		var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address);
		expect(Number(afterDepTokenAcc.amount)).to.equal(0);
		
		var afterRef = await getAccount(provider.connection, refTokenAccount.address);
		var refEarn = (Number(afterRef.amount) - Number(beforeRef.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.publicKey.toBase58()) {
			expect(refEarn).to.equal(0);
		} else {
			expect(refEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.25 / 100);
		}
		
		var afterWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address);
		var wkBeneficiaryEarn = (Number(afterWkBeneficiary.amount) - Number(beforeWkBeneficiary.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.publicKey.toBase58()) {
			expect(wkBeneficiaryEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.5 / 100);
		} else {
			expect(wkBeneficiaryEarn).to.equal((mintAmount/LAMPORTS_PER_SOL) * 0.25 / 100);
		}
		*/
	});
	
});