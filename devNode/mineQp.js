const { ethers } = require('ethers');
const { CHAIN_CONFIG } = require('../contracts/config/chain.js');
const { accounts } = require('../contracts/config/account.js');
const { deploy, connect, connectGateway, mine } = require('./utils.js');
const BASE = 'http://127.0.0.1:';

async function getWallet() {
  let wallet;
  if (accounts.mnemonic) {
      wallet = ethers.Wallet.fromMnemonic(accounts.mnemonic);
      console.log('Test account used from MNEMONIC', wallet.privateKey, wallet.address);
  } else {
      wallet = new ethers.Wallet(accounts[0]);
      console.log('Test account used from TEST_ACCOUNT_PRIVATE_KEY', wallet.address);
  }
  return wallet;
}

async function getProvider(network) {
  const chain = CHAIN_CONFIG[network];
  if (!chain) {
    throw new Error(`Invalid network ${network}. Not found in configs.`);
  }
  const provider = new ethers.providers.JsonRpcProvider(BASE + chain.forkPort);
  const chainId = chain.forkChainId; //await provider.getNetwork().then(network => network.chainId);
  if (!chainId) {
    throw new Error(`No chainID configured for ${network}`);
  }
  console.log(`Connected to ${network} with chainId ${chainId}`);
  return {provider, chainId};
}

async function deployContracts() {
  const argv = process.argv.slice(3);
  const network = argv[0];
  if (!network) {
    throw new Error(`Network not provided. Please provide a network to deploy to.`);
  }
  const p = await getProvider(network);
  const wallet = (await getWallet()).connect(p.provider);
  const deped = await deploy(wallet, p.chainId);
  const connected = await connect(wallet, deped.mgr, deped.portal, deped.token);
  console.log('Contracts deployed', {...deped, network, chainId: connected.chainId});
}

async function _mine() {
  const argv = process.argv.slice(3);
  const ngate1 = argv[0];
  const ngate2 = argv[1];
  if (!ngate1 || !ngate2) {
    throw new Error('Please provide two networks with gateways to mine. SourceNetwork:Gateway => TargetNetwork:Gateway');
  }
  const [network1, gateway1] = ngate1.split(':');
  const [network2, gateway2] = ngate2.split(':');
  const p1 = getProvider(network1);
  const p2 = getProvider(network2);

  const blockNumber1 = await p1.provider.getBlockNumber();
  const blockNumber2 = await p2.provider.getBlockNumber();
  console.log(`PROVIDERS: ${blockNumber1} and ${blockNumber2}`);
  console.log(`Connecting to ${gateway1} on ${network1}`);
  const chain1 = await connectGateway(await getWallet(network1), gateway1);
  console.log(`Connecting to ${gateway2} on ${network2}`);
  const chain2 = await connectGateway(await getWallet(network2), gateway2);
  console.log(`Mining from chain ${network1}:${gateway1} to ${network2}:${gateway2}`);
  await mine(chain1, chain2);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === 'mine') {
    await _mine();
    return;
  } else if (command === 'deploy') {
    await deployContracts();
    return;
  } else {
    throw new Error(`Invalid command "${command}"`);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});