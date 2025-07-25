import * as anchor from "@coral-xyz/anchor";
import { BN, BorshCoder,Program, AnchorError, EventParser } from "@coral-xyz/anchor";
import { Warmkey } from "../target/types/warmkey";
import { Keypair, SystemProgram, PublicKey, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY ,} from '@solana/web3.js';
import { expect } from "chai";
const {ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createMint, getAssociatedTokenAddress, getOrCreateAssociatedTokenAccount, mintTo, getAccount, transfer, AuthorityType, createSetAuthorityInstruction, createAssociatedTokenAccountInstruction,createApproveInstruction, } = require("@solana/spl-token");
import { Emit } from "../target/types/emit";
const fs = require('fs');

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

describe("----- WARMKEY CORE -----", async () => {
	
	// Configure the client to use the local cluster.
	const provider = anchor.AnchorProvider.env();
	anchor.setProvider(provider);
	const program = anchor.workspace.warmkey as Program<Warmkey>;

	let merchantWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
	let merchantTokenAccount;
	let merchantData: PublicKey;

	var beneficiariesWallet = [(anchor.web3.Keypair.generate()).publicKey, (anchor.web3.Keypair.generate()).publicKey, (anchor.web3.Keypair.generate()).publicKey];
	var beneficiariesTokenAccount = [];
	
	let bump: number;
	
	let mint;
	
	let wkBeneficiary = new PublicKey("5W9kUdZMPk5gR6XiRVyri2cps1kJRY3b8eb6b76qYiEX");
	let wkBeneficiaryTokenAcc;
	
	
	//let referral = wkBeneficiary;
	let referral: anchor.web3.Keypair = anchor.web3.Keypair.generate();
	let refTokenAccount;
	
	let programAcc: PublicKey;

	let wkSigner;

	const testToken2022 = true;
	let thisTokenProgramId;

	before(async () => {

		thisTokenProgramId = testToken2022 ?  TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

		wkSigner  = anchor.web3.Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("/home/ubuntu/.config/solana/hwwKYKJ57UASjFDhCp3jtGwmJV2DBEGPjRodvHd2ZJq.json", "utf-8"))));	

		console.log("wkSigner", wkSigner.publicKey.toBase58());
		
		console.log("provider wallet:", provider.wallet.publicKey.toBase58());
		/*
		// check account info
		const accountInfo = await provider.connection.getAccountInfo(provider.wallet.publicKey);
		console.log(JSON.stringify(accountInfo, null, 2));
		return;
		*/
		
		console.log("program id:", program.programId.toBase58());
		
		// create new mint (original token, 9 decimals)
		mint = await createMint(
			provider.connection,
			provider.wallet.payer,    // fee payer
			provider.wallet.publicKey,// mint authority
			provider.wallet.publicKey,// freeze authority
			9,                         // decimals
			anchor.web3.Keypair.generate(),
			null,
			thisTokenProgramId
		);
		console.log("new token mint:", mint.toBase58());
		
		
		const block = await provider.connection.getLatestBlockhash();
		console.log("blockhash:", block.blockhash, "height:", block.lastValidBlockHeight);

		//create beneficiary token acc
		for(var i=0; i< beneficiariesWallet.length; i++) {
			let beneficiaryWallet = beneficiariesWallet[i];

			let wkBeneficiaryTokenAcc = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,   // payer
				mint,                    // the token mint
				beneficiaryWallet, // token owner
				false,
				null, 
				null,
				thisTokenProgramId
			);

			beneficiariesTokenAccount.push(wkBeneficiaryTokenAcc);
		}
		
		//create wk beneficiary token acc
		wkBeneficiaryTokenAcc = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,   // payer
			mint,                    // the token mint
			wkBeneficiary, // token owner
			false,
			null, 
			null,
			thisTokenProgramId
		);
		console.log("wk beneficiary ata:", wkBeneficiaryTokenAcc.address.toBase58());
		
		//===== process referral =====
		if (wkBeneficiary.toBase58() != referral.publicKey.toBase58()) {
			// create referral token account
			refTokenAccount = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,   // payer
				mint,                    // the token mint
				referral.publicKey, // token owner
				false,
				null, 
				null,
				thisTokenProgramId
			);
			console.log("referral token account:", refTokenAccount.address.toBase58());
		} else {
			refTokenAccount = wkBeneficiaryTokenAcc;
		}
		
		//===== process merchant =====
		
		// fund sol to merchant wallet
		await provider.connection.confirmTransaction(
			await provider.connection.requestAirdrop(merchantWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL * 2000)
		);
		
		console.log("merchant wallet:", merchantWallet.publicKey.toBase58());
		
		// create merchant token account
		merchantTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer,   // payer
			mint,                    // the token mint
			merchantWallet.publicKey, // token owner
			false,
			null, 
			null,
			thisTokenProgramId
		);
		console.log("merchant token account:", merchantTokenAccount.address.toBase58());
		
		// get merchant pda
		[merchantData, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('merchant'), merchantWallet.publicKey.toBuffer()],
			program.programId
		);
		console.log("merchant pda:", merchantData.toBase58());
		
		//===== setup program =====
		[programAcc, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('programstate'), provider.wallet.payer.publicKey.toBuffer()],
			program.programId
		);
		console.log("program stater:", programAcc.toBase58());
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
		console.log("tx size:", getTxSize(tx, provider.wallet.payer.publicKey));
		
	});
	
	it("----- REGISTER -----", async () => {
		
		var beforeBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		var tx = await program.methods
			.register( referral.publicKey, [merchantWallet.publicKey] )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		
		const regTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('register tx:', regTx);
		var afterBalance = await provider.connection.getBalance(merchantWallet.publicKey);
		const regTxDetails = await program.provider.connection.getTransaction(regTx, {maxSupportedTransactionVersion: 0, commitment: "confirmed"});

		var balance = await provider.connection.getBalance(merchantData);
		
		const getMerchantDataAcc = await provider.connection.getAccountInfo(merchantData);
		console.log("merchant acc length:", getMerchantDataAcc.data.length);
		var rentExemption = await program.provider.connection.getMinimumBalanceForRentExemption(getMerchantDataAcc.data.length);
		
		console.log("reg fees:");
		console.log("  SOL changes:", (beforeBalance - afterBalance) / LAMPORTS_PER_SOL);
		console.log("  tx fees:", regTxDetails.meta.fee / LAMPORTS_PER_SOL);
		console.log("  rent exemption:", rentExemption / LAMPORTS_PER_SOL);
		console.log("  merchant acc:", balance / LAMPORTS_PER_SOL);
		
		// validate merchant pda's owner
		if (getMerchantDataAcc === null) {
			throw new Error('merchant account does not exist!');
		}
		expect(getMerchantDataAcc.owner.toBase58()).to.equal(program.programId.toBase58(), "merchant account's owner must be deployed program address");
		
		// validate log
		var logs = regTxDetails?.meta?.logMessages || null;
		if (!logs) {
			throw new Error('register log not found!');
		}
		//console.log("register log:", logs);
		
		const eventParser = new EventParser(program.programId, new BorshCoder(program.idl));
		const events = eventParser.parseLogs(logs);
		for (let event of events) {
			//console.log(event);
		}
		
		var merchantDataAcc = await program.account.merchantData.fetch(merchantData);
		expect(merchantDataAcc.authority.toBase58()).to.equal(merchantWallet.publicKey.toBase58());

		console.log("-- registred beneficiaries:", merchantDataAcc.beneficiaries);
		

		var tx = await program.methods
			.depUpdateBeneficiary( beneficiariesWallet )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				wkSigner: wkSigner.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		var updateBeneficiaryTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet, wkSigner], { commitment: "confirmed" });
		console.log('after update beneficiary tx:', updateBeneficiaryTx);

		merchantDataAcc = await program.account.merchantData.fetch(merchantData);
		console.log("-- beneficiaries:", merchantDataAcc.beneficiaries);

		var tx = await program.methods
			.depUpdateBeneficiary( [merchantWallet.publicKey] )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				wkSigner: wkSigner.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		updateBeneficiaryTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet, wkSigner], { commitment: "confirmed" });
		console.log('revert update beneficiary tx:', updateBeneficiaryTx);

		merchantDataAcc = await program.account.merchantData.fetch(merchantData);
		console.log("-- beneficiaries:", merchantDataAcc.beneficiaries);

		var tx = await program.methods
			.depUpdateBeneficiary( beneficiariesWallet )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				wkSigner: wkSigner.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		var updateBeneficiaryTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet, wkSigner], { commitment: "confirmed" });
		console.log('undo revert beneficiary tx:', updateBeneficiaryTx);

		merchantDataAcc = await program.account.merchantData.fetch(merchantData);
		console.log("-- beneficiaries:", merchantDataAcc.beneficiaries);


		
	});
	
	it("----- FUND OUT -----", async () => {
		
		let depositWallets = [anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()/*, anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate(), anchor.web3.Keypair.generate()*/];
		let depositTokenAccounts = [];
		
		//batch transfer SOL to $depositWallets
		var accountMetas = [];
		var amounts = [];
		for(var x in depositWallets) {
			var depositWallet = depositWallets[x];
			accountMetas.push({pubkey: depositWallet.publicKey, isWritable: true, isSigner: false});
			amounts.push(new BN(anchor.web3.LAMPORTS_PER_SOL));
		}

		
		// 2 persons: 64767 CU, 3 persons: 82675 CU, 4 persons: 106583 CU, 5 persons: 130491 CU
		var tx = await program.methods
			.depSupplyApprovalGas( new BN(123), amounts )
			.remainingAccounts(accountMetas)
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const supplyGasTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log('supply gas tx:', supplyGasTx);
		console.log("tx size:", getTxSize(tx, merchantWallet.publicKey));
		const supplyGasTxDetails = await program.provider.connection.getTransaction(supplyGasTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		//console.log(supplyGasTxDetails);

		var balances = await program.methods.getSolBalances()
		.remainingAccounts(accountMetas)
		.view();
		console.log("sol balances:", balances);


		const mintAmount = 100 * 10 ** 9;
		for(var x in depositWallets) {
			let depositWallet = depositWallets[x];
			// fund sol to deposit wallet
			await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(depositWallet.publicKey, anchor.web3.LAMPORTS_PER_SOL));
			
			console.log("deposit wallet:", depositWallet.publicKey.toBase58());

			// create deposit token account
			let created = await getOrCreateAssociatedTokenAccount(
				provider.connection,	
				provider.wallet.payer,  // payer
				mint,                   // the token mint
				depositWallet.publicKey, // token owner
				false,
				null, 
				null,
				thisTokenProgramId
			);
			
			depositTokenAccounts.push(created);
			var depositTokenAccount = depositTokenAccounts[depositTokenAccounts.length - 1];
			console.log("deposit token account:", depositTokenAccount.address.toBase58());
			
			await mintTo(
				provider.connection,
				provider.wallet.payer, // fee payer
				mint,
				depositTokenAccount.address,
				provider.wallet, // mint authority
				mintAmount,
				[provider.wallet],
				null,
				thisTokenProgramId
			);

			// change account owner to merchant pda
			if (testToken2022) {
				// delegate max amount from wdTokenAccount to wdAgent
				var tx = new Transaction().add(
					createApproveInstruction(
						depositTokenAccount.address,// token account
						merchantData,                // new authorizer
						depositWallet.publicKey,    // owner
						new BN("18446744073709551615"),    
						[depositWallet.publicKey],
						thisTokenProgramId
					),
				);

				var setApprovalTx = await sendAndConfirmTransaction(provider.connection, tx, [depositWallet], { commitment: "confirmed" });
				console.log("set approval tx:", setApprovalTx);
			} else {
				var tx = new Transaction().add(
					createSetAuthorityInstruction(
						depositTokenAccount.address, // token account
						depositWallet.publicKey,     // current auth
						AuthorityType.AccountOwner,  // authority type
						merchantData,                 // new auth
						[],
						thisTokenProgramId,            // token program
					),
				);
				const setAuthTx = await sendAndConfirmTransaction(provider.connection, tx, [depositWallet], { commitment: "confirmed" });
				console.log('set auth tx:', setAuthTx);

				var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address, null, thisTokenProgramId);
				expect(afterDepTokenAcc.owner.toBase58()).to.equal(merchantData.toBase58(), "token account's owner now must be merchant acc (PDA)");
			}
		}
		
		// fundout
		var getMerchantData = await program.account.merchantData.fetch(merchantData);
		var beforeWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address, null, thisTokenProgramId);
		var beforeRef = await getAccount(provider.connection, refTokenAccount.address, null, thisTokenProgramId);
		
		var accountMetas = [];
		for(var x in depositTokenAccounts) {
			var depositTokenAccount = depositTokenAccounts[x];
			accountMetas.push({pubkey: depositTokenAccount.address, isWritable: true, isSigner: false});
		}

		// check token balances
		var balances = await program.methods.getTokenBalances()
		.remainingAccounts(accountMetas)
		.view();
		console.log("token balances:", balances);


		// check delegated amount
		var balances = await program.methods.getDelegatedAmounts()
		.remainingAccounts(accountMetas)
		.view();
		console.log("delegated amounts:", balances);

		//1 deposit account = 45354 CU, 2 deposit account = 61764
		//1 deposit account = 23968 CU, 2 deposit account = 39094

		let beneficiaryTokenIndex = 0;
		//await sleep(5000);
		var tx = await program.methods
			.depFundout( beneficiaryTokenIndex/*merchant beneficiary index*/ )
			.remainingAccounts(accountMetas)
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				referral: refTokenAccount.address,
				beneficiaryAcc: beneficiariesTokenAccount[beneficiaryTokenIndex].address,
				wkBeneficiary: wkBeneficiaryTokenAcc.address,
				tokenProgram: thisTokenProgramId, 
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
		//console.log(fundoutTxDetails);
		
		for(var x in depositTokenAccounts) {
			var depositTokenAccount = depositTokenAccounts[x];
			var afterDepTokenAcc = await getAccount(provider.connection, depositTokenAccount.address, null, thisTokenProgramId);
			expect(Number(afterDepTokenAcc.amount)).to.equal(0);
			
		}
		var totalFundout =  depositWallets.length * (mintAmount/LAMPORTS_PER_SOL);
		var afterRef = await getAccount(provider.connection, refTokenAccount.address, null, thisTokenProgramId);
		var refEarn = (Number(afterRef.amount) - Number(beforeRef.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.toBase58()) {
			expect(refEarn).to.equal(0);
		} else {
			expect(refEarn).to.equal( totalFundout * 0.25 / 100 );
		}
		
		var afterWkBeneficiary = await getAccount(provider.connection, wkBeneficiaryTokenAcc.address, null, thisTokenProgramId);
		var wkBeneficiaryEarn = (Number(afterWkBeneficiary.amount) - Number(beforeWkBeneficiary.amount)) / LAMPORTS_PER_SOL;
		if (getMerchantData.referral.toBase58() == wkBeneficiary.toBase58()) {
			expect(wkBeneficiaryEarn).to.equal( totalFundout * 0.5 / 100);
		} else {
			expect(wkBeneficiaryEarn).to.equal( totalFundout * 0.25 / 100);
		}
	});
	
	it("---- WITHDRAWAL -----", async () => {
		//enable withdrawal
		let wdWallet: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let wdTokenAccount;
		let wdAgent;
		let wdDataPda;
		
		[wdAgent, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('wdagent'), wdWallet.publicKey.toBuffer()],
			program.programId
		);
		console.log("wd agent:", wdAgent.toBase58());
		
		[wdDataPda, bump] = await PublicKey.findProgramAddress(
			[Buffer.from('wddata'), wdWallet.publicKey.toBuffer(), mint.toBuffer()],
			program.programId
		);
		console.log("wd data acc:", wdDataPda.toBase58());
		
		var tx = await program.methods
			.wdEnable()
			.accounts({
				signer: merchantWallet.publicKey,
				wkSigner: wkSigner.publicKey,
				wdExecutor: wdWallet.publicKey,
				merchantData: merchantData,
				wdAgent: wdAgent,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const wdEnableTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet, wkSigner], { commitment: "confirmed" });
		//var thisAcc = await provider.connection.getAccountInfo(wdAgent);
		//console.log("wd executor pda:", thisAcc);
		console.log('wd enable tx:', wdEnableTx);
		
		// supply gas to wdWallet
		var tx = await program.methods
			.wdSupplyExecutorGas( new BN(anchor.web3.LAMPORTS_PER_SOL) )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				wdExecutor: wdWallet.publicKey,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const supplyGasTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log("supply gas tx:", supplyGasTx);
		
		// create wd token account 
		wdTokenAccount = await getOrCreateAssociatedTokenAccount(
			provider.connection,	
			provider.wallet.payer, // payer
			mint,                  // the token mint
			wdWallet.publicKey,     // token owner,
			false,
			null, 
			null,
			thisTokenProgramId
		);
		
		// prohibited by 2022
			// change account owner to wd agent
		if (testToken2022) {
			// delegate max amount from wdTokenAccount to wdAgent
			var tx = new Transaction().add(
				createApproveInstruction(
					wdTokenAccount.address,// token account
					wdAgent,                // new authorizer
					wdWallet.publicKey,    // owner
					new BN("18446744073709551615"),    
					[wdWallet.publicKey],
					thisTokenProgramId
				),
			);

			var setApprovalTx = await provider.sendAndConfirm(tx, [wdWallet]);
			console.log("set approval tx:", setApprovalTx);
		} else {
			var tx = new Transaction().add(
				createSetAuthorityInstruction(
				wdTokenAccount.address, // token account
				wdWallet.publicKey,     // current auth
				AuthorityType.AccountOwner,  // authority type
				wdAgent,                 // new auth
				[],
				thisTokenProgramId,            // token program
				),
			);

			const setAuthTx = await provider.sendAndConfirm(tx, [wdWallet]);
			console.log("set auth tx:", setAuthTx);
		}
		
		
		
		//var wdTokenAcc = await getAccount(provider.connection, wdTokenAccount.address,null, thisTokenProgramId);
		//console.log("wd TA balance:", wdTokenAcc.amount, wdTokenAcc.delegatedAmount, wdTokenAcc.delegate.toBase58());
		//return;

		
		//===== SUPPLY ROLLING =====
		const mintAmount = 100 * 10 ** 9;
		// delegate max amount from merchantTokenAccount to merchantPda
		var tx = new Transaction().add(
			createApproveInstruction(
				merchantTokenAccount.address,// token account
				merchantData,                // new authorizer
				merchantWallet.publicKey,    // owner
				mintAmount,        //delegated amount, change to max 18446744073709551615
				[merchantWallet.publicKey],
				thisTokenProgramId
			),
		);
		var setApprovalTx = await provider.sendAndConfirm(tx, [merchantWallet]);
		console.log("set approval tx:", setApprovalTx);
		
		// fund 100 tokens to merchantTokenAccount
		
		await mintTo(
			provider.connection,
			provider.wallet.payer,        // fee payer
			mint,
			merchantTokenAccount.address, //to
			provider.wallet,              // mint authority
			mintAmount,
			[provider.wallet],
			null,
			thisTokenProgramId
		);
		console.log("mint to:", "ok")
		
		//var merchantTokenAcc = await getAccount(provider.connection, merchantTokenAccount.address, null, thisTokenProgramId);
		//console.log("merchant TA balance:", merchantTokenAcc.amount, merchantTokenAcc.delegatedAmount, merchantData.toBase58(), merchantTokenAcc.delegate.toBase58());
		
		await sleep(2500);
		// supply rolling
		var tx = await program.methods
			.wdSupplyRolling( new BN(mintAmount) )
			.accounts({
				merchantData: merchantData,
				signer: merchantWallet.publicKey,
				merchantToken: merchantTokenAccount.address,
				wdToken: wdTokenAccount.address,
				tokenProgram: thisTokenProgramId,
				systemProgram: SystemProgram.programId,
			})
			.transaction();
			
		const wdSupplyRollingTx = await sendAndConfirmTransaction(provider.connection, tx, [merchantWallet], { commitment: "confirmed" });
		console.log("supply rolling tx:", wdSupplyRollingTx);
		//return;
		
		//===== PAYOUT =====
		
		// payout to 2 recipients
		let recipient1: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient2: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient3: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient4: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient5: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient6: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient7: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		let recipient8: anchor.web3.Keypair = anchor.web3.Keypair.generate();
		
		var requests = [
			[ mint, recipient1, new BN(1), new BN(1), new BN(43) ],
			[ mint, recipient2, new BN(2), new BN(2), new BN(44) ],
			[ mint, recipient3, new BN(3), new BN(3), new BN(45) ],
			[ mint, recipient4, new BN(4), new BN(4), new BN(46) ],			
		];

		//about to test duplicate recipient
		var requests2 = [
			[ mint, recipient1, new BN(5), new BN(5), new BN(47) ],
			[ mint, recipient2, new BN(6), new BN(6), new BN(48) ],
			[ mint, recipient3, new BN(7), new BN(7), new BN(49) ],
			[ mint, recipient4, new BN(8), new BN(8), new BN(50) ],
		]

		var tx = new Transaction();
		var accountMetas = [];
		var createAtaIdxs = [];
		var amounts = [];
		var ourIds = [];
		var theirIds = [];
		for(var x in requests) {
			var request = requests[x];
			var _mint = request[0]; 
			var _recipient = request[1];
			var _amount = request[2]; amounts.push( _amount );
			var _our_id = request[3]; ourIds.push( _our_id );
			var _their_id = request[4]; theirIds.push( _their_id );

			if (x % 2 == 0) {
				console.log("test has ATA");
				//test has ATA
				var recipientTokenAcc = await getOrCreateAssociatedTokenAccount(
					provider.connection, 
					provider.wallet.payer, 
					_mint, 
					_recipient.publicKey,
					false,
					null, 
					null,
					thisTokenProgramId
				);
				recipientTokenAcc = recipientTokenAcc.address;
			} else { 
				console.log("test has no ATA");
				//test has no ATA
				var recipientTokenAcc = await getAssociatedTokenAddress(
					_mint, 
					_recipient.publicKey,
					false,
					thisTokenProgramId
				);
			}
			
			var thisAcc = await provider.connection.getAccountInfo(recipientTokenAcc);
			if (thisAcc === null) {
				
				accountMetas.push({pubkey: recipientTokenAcc, isWritable: true, isSigner: false});
				createAtaIdxs.push(new BN(accountMetas.length - 1));
				accountMetas.push({pubkey: _recipient.publicKey, isWritable: false, isSigner: false});

			} else {
				accountMetas.push({pubkey: recipientTokenAcc, isWritable: true, isSigner: false});
			}
		}

		for(var x in requests2) {
			var request = requests2[x];
			var _mint = request[0]; 
			var _recipient = request[1];
			var _amount = request[2]; amounts.push( _amount );
			var _our_id = request[3]; ourIds.push( _our_id );
			var _their_id = request[4]; theirIds.push( _their_id );

			var recipientTokenAcc = await getAssociatedTokenAddress(
				_mint, 
				_recipient.publicKey,
				false,
				thisTokenProgramId
			);

			accountMetas.push({pubkey: recipientTokenAcc, isWritable: true, isSigner: false});
			
		}

		await sleep(2500);
		// Vec<u64} type need not to be process by Buffer.from, lol??
		var payoutInstr = await program.methods
				.wdPayout(amounts, ourIds, theirIds, Buffer.from(createAtaIdxs))
				.remainingAccounts(accountMetas)
				.accounts({
					wdAgent: wdAgent,
					wdData: wdDataPda,
					signer: wdWallet.publicKey,
					funder: wdTokenAccount.address,
					tokenProgram: thisTokenProgramId,
					systemProgram: SystemProgram.programId,
					mint: mint,
					associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
					rent: SYSVAR_RENT_PUBKEY,
				})
				.transaction();
		tx.add(payoutInstr);

		const payoutTx = await provider.sendAndConfirm(tx, [wdWallet],{ commitment: "confirmed" });
		const payoutTxDetails = await program.provider.connection.getTransaction(payoutTx, {
			maxSupportedTransactionVersion: 0,
			commitment: "confirmed",
		});
		
		
		console.log("");
		console.log('payout tx:', payoutTx);
		console.log("tx size:", getTxSize(tx, wdWallet.publicKey));
		//console.log(payoutTxDetails);
		
		//check recipient receive amount

		// add amount from requests2 to requests
		for(var x in requests2) {
			var request = requests2[x];
			var _amount = request[2];
			requests[x][2] =  requests[x][2].add(_amount) ;
		}

		for(var x in requests) {
			var request = requests[x];
			var _mint = request[0];
			var _recipient = request[1];
			var _amount = request[2];

			var recipientTokenAddr = await getAssociatedTokenAddress(
				_mint, 
				_recipient.publicKey,
				false,
				thisTokenProgramId
			);
			
			var recipientTokenAcc = await getAccount(provider.connection, recipientTokenAddr, null, thisTokenProgramId);
					
			expect(Number(recipientTokenAcc.amount)).to.equal(Number(_amount));

		}

		var wdDataAccDetails = await program.account.wdData.fetch(wdDataPda);
		console.log("wd data's last wd id:", wdDataAccDetails.lastWdId.toString());
	});

});