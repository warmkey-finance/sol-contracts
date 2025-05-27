import * as anchor from "@coral-xyz/anchor";

const pubKeyToPrograms = async (publicKey: string) => {

  const web3 = anchor.web3;
  const connection = new web3.Connection(
    "https://api.mainnet-beta.solana.com"
  );

  const accounts = await connection.getProgramAccounts(
    new web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
    {
      dataSlice: {
        offset: 4 + 8 + 1 + 32,
        length: 0,
      },
      filters: [
        {
          memcmp: {
            offset: 0,
            bytes: anchor.utils.bytes.bs58.encode([3, 0, 0, 0]),
          },
        },

        {
          memcmp: {
            offset: 4 + 8,
            bytes: anchor.utils.bytes.bs58.encode([1]),
          },
        },

        {
          memcmp: {
            offset: 4 + 8 + 1,
            bytes: new web3.PublicKey(
              publicKey
            ).toBase58(),
          },
        },
      ],
    }
  );
  console.log("RESULTS: ", accounts);
};

await pubKeyToPrograms("EjC3ciptXau6mYyS1RcsyJpDshREhVKPdVAmawLLNsZU");