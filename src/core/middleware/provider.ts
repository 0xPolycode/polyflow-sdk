import { BigNumber } from '@ethersproject/bignumber';
import { AwesomeGraphQLClient } from 'awesome-graphql-client';
import * as encoding from "@walletconnect/encoding";
import * as isoCrypto from "@walletconnect/crypto";
import * as timeZoneCityToCountry from "../localization/tz-cities-to-countries.json";
import HttpProvider from 'web3-providers-http';
import { JsonRpcResponse } from 'web3-core-helpers';
import uaParser from 'ua-parser-js';

class Web3HttpProvider extends HttpProvider {
  async request(payload: any): Promise<JsonRpcResponse | null> {
    return new Promise((resolve, reject) => {
      this.send({
        ...payload,
        id: 1,
        jsonrpc: "2.0"
      }, (err, result) => {
        if (err) { reject(err); }
        resolve(result?.result);
      })
    });
  }
}

const PF_SDK_SESSION_KEY = 'PF_SDK_SESSION_KEY';
const PF_SDK_USER_KEY = 'PF_SDK_USER_KEY';
const PF_SDK_UTM_KEY = 'PF_SDK_UTM_KEY';
const PF_LAST_ERROR_LOGGED_KEY = "PF_LAST_ERROR_LOGGED_KEY";
const PF_LAST_USER_LANDED_WALLET_KEY = "PF_LAST_USER_LANDED_WALLET_KEY";
const PF_LAST_USER_LANDED_PATH_KEY = "PF_LAST_USER_LANDED_PATH_KEY";

type EventTracker = 'WALLET_CONNECT' | 'USER_LANDED' | 'TX_REQUEST' | 'GENERIC_ERROR';

const CreateUserLandedEvent = `
  mutation CreateUserLandedEvent($event: UserLandedEventInput!) {
    createUserLandedEvent(event: $event) {
      id
    }
  }
`

const CreateWalletConnectedEvent = `
  mutation CreateWalletConnectedEvent($event: WalletConnectedEventInput!) {
    createWalletConnectedEvent(event: $event) {
      id
    }
  }
`

const CreateTxRequestEvent = `
  mutation CreateTxRequestEvent($event: TxRequestEventInput!) {
    createTxRequestEvent(event: $event) {
      id
    }
  }
`

const UpdateTxRequestEventTxStatus = `
  mutation UpdateTxRequestEventTxStatus($id: UUID!, $newStatus: TxStatus!) {
    updateTxRequestEventTxStatus(id: $id, newStatus: $newStatus) {
      id
    }
  }
`

const CreateErrorEvent = `
  mutation CreateErrorEvent($event: ErrorEventInput!) {
    createErrorEvent(event: $event) {
      id
    }
  }
`

const CreateBlockchainErrorEvent = `
  mutation CreateBlockchainErrorEvent($event: BlockchainErrorEventInput!) {
    createBlockchainErrorEvent(event: $event) {
      id
    }
  }
`

let proxy: any;
let provider = (window as any).ethereum;
let connectedAccounts: string[];
let gqlClient: AwesomeGraphQLClient;

enum Environment {
  STAGING = "https://backend-staging.polyflow.dev/api/graphql",
  PROD = "https://backend-prod.polyflow.dev/api/graphql" 
}
let ENV: Environment = Environment.STAGING; 
let LOG_ENABLED = true;
let wcObject: WCObject | null = null;

export function attach(apiKey: string) {
  gqlClient = new AwesomeGraphQLClient({
    endpoint: ENV,
    fetchOptions: {
      headers: {
        'X-API-KEY': apiKey
      }
    }
  });

  if (!LOG_ENABLED) {
    console.log = function(){}; // disable log output
  }

  storeUtmParams();
  fetchWcObjet();
  addUrlChangeListener();
  addLocalStorageListener();
  initializeProviderProxy();
  initializeWsProxy();
  addProviderListeners();
  logUserLanded();

  window.onerror = errorHandler;
  window.onunhandledrejection = function(errorEvent) {
    console.log("PF >>> uhandled rjection: ", errorEvent);
    let errors: string[] = [];
    if (errorEvent.reason) {
      if (errorEvent.reason.message) { errors.push(errorEvent.reason.message.toString()); }
      if (errorEvent.reason.stack) { errors.push(errorEvent.reason.stack.toString()); }
      logErrors(errors);
    } else {
      logErrors([JSON.stringify(errorEvent)]);
    }
  }
  return window.origin;
}

const wsMessages = new Map<string, any>([]);
export function initializeWsProxy() {
  console.log("PF >>> Initializing ws proxy...");
  const OriginalWebsocket = (window as any).WebSocket
  const ProxiedWebSocket = function() {
    const ws = new OriginalWebsocket(...arguments)
    
    // incoming messages
    ws.addEventListener("message", async (e: any) => {
      console.log("PF >>> Intercepted incoming ws message", e.data);
      if (!wcObject) {
        console.log("PF >>> Could not fetch wc object. Giving up on processing ws message: ", e.data);
        return;
      }
      const messageObj = JSON.parse(e.data);
      if (!messageObj) {
        console.log("PF >>> Could not parse ws message. Giving up on processing ws message: ", e.data);
        return;
      }

      console.log("PF >>> Parsed ws message to object: ", messageObj);
      if (messageObj.payload && messageObj.topic === wcObject.clientId) {
        console.log("PF >>> Message is a walletconnect message");
        const payload = JSON.parse(messageObj.payload);
        if (!payload) { 
          console.log("PF >>> Could not parse payload:", messageObj.payload);
          return;
        }
        console.log("PF >>> Parsed payload: ", payload);
        const decrypted = await decrypt(payload, wcObject);
        if (decrypted.id && wsMessages.has(decrypted.id)) {
          console.log("PF >>> Payload is a response to an eth_sendTransaction message");
          const hash = decrypted.result;
          console.log("PF >>> Transaction hash: ", hash);
          const txData = wsMessages.get(decrypted.id);
          console.log("PF >>> Transaction data: ", txData);
          logSendTransaction(txData, hash, {
            provider: await wcObjectToWeb3Provider(wcObject),
            type: 'walletconnect',
            wallet: txData.from,
            walletProvider: wcObject.peerMeta.name.toLowerCase()
          });
        } else { console.log("PF >>> Payload is not a response to eth_sendTransaction message..."); }
      } else { console.log("PF >>> Message is not a walletconnect message"); }
    })

    // outgoing messages
    const originalSend = ws.send
    const proxiedSend = function () {
      console.log("PF >>> Intercepted outgoing ws message", arguments);
      if (!wcObject) {
        console.log("PF >>> Could not fetch wc object. Giving up on processing ws message: ", arguments[0]);
        return originalSend.apply(this, arguments);
      }
      const messageObj = JSON.parse(arguments[0]);
      if (!messageObj) {
        console.log("PF >>> Could not parse ws message. Giving up on processing ws message: ", arguments[0]);
        return originalSend.apply(this, arguments);
      }
      
      console.log("PF >>> Parsed ws message to object: ", messageObj);
      if (messageObj.payload && messageObj.topic === wcObject.peerId) {
        console.log("PF >>> Message is a walletconnect message");
        const payload = JSON.parse(messageObj.payload);
        if (!payload) { 
          console.log("PF >>> Could not parse payload:", messageObj.payload);
          return originalSend.apply(this, arguments);
        }
        console.log("PF >>> Parsed payload: ", payload);
        decrypt(payload, wcObject).then(decrypted => {
          if (decrypted.id && decrypted.method && decrypted.method === 'eth_sendTransaction') {
            console.log("PF >>> Payload is eth_sendTransaction request with id: ", decrypted.id);
            const params = decrypted.params[0];
            console.log("PF >>> Storing tx params object: ", params);
            wsMessages.set(decrypted.id, params);
          } else { console.log("PF >>> Payload not eth_sendTransaction: ", decrypted); }
        })
      } else { console.log("PF >>> Message is not a walletconnect message"); }

      return originalSend.apply(this, arguments);
    }
    ws.send = proxiedSend
    return ws;
  };
  (window as any).WebSocket = ProxiedWebSocket;
}

interface Payload {
  data: string,
  hmac: string,
  iv: string
}
async function decrypt(payload: Payload, wcObject: WCObject): Promise<any> {
  console.log("PF >>> Decrypting payload: ", payload);
  console.log("PF >>> with wc object: ", wcObject);
  
  const key = encoding.hexToArray(wcObject.key);
  const iv = encoding.hexToArray(payload.iv);
  const data = encoding.hexToArray(payload.data);
  
  const decrypted = await isoCrypto.aesCbcDecrypt(iv, key, data);
  const decryptedString = encoding.arrayToUtf8(decrypted);
  console.log("PF >>> Decrypted data: ", decryptedString);
  return JSON.parse(decryptedString);
}

function initializeProviderProxy() {
  Object.defineProperty(window, 'ethereum', {
    get() {
      console.log("PF >>> provider get!");
      if (!proxy && provider) {
        proxy = new Proxy(provider, handler);
        provider = undefined;
        console.log('PF >>> am attached!]');
        console.log("PF >>> proxy data: ", proxy);
      }
      return proxy;
    },
    set(newProvider) {
      console.log("PF >>> provider set!");
      proxy = new Proxy(newProvider, handler);
      console.log("PF >>> proxy data: ", proxy);
    },
    configurable: true,
  });
}

const proxiedFunctions = ['request'];
const handler = {
  get(target: any, prop: any, receiver: any) {
    if (!proxiedFunctions.includes(prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return async (...args: any) => {
      const arg0IsMethodString = typeof args[0] === 'string';
      const method = arg0IsMethodString ? args[0] : args[0].method;
      const params = arg0IsMethodString ? args[1] : args[0].params;

      console.log('PF >>> Intercepted method: ', method);
      console.log('PF >>> With params: ', params);

      /* eslint-disable no-fallthrough */
      switch (method) {
        default: {
          const result = await Reflect.get(target, prop, receiver)(...args);
          console.log("PF >>> Executed method on target object with result: ", result);
          if (method === 'eth_requestAccounts') {
            logWalletConnect({
              provider: (window as any).ethereum,
              type: 'injected',
              wallet: result[0],
              walletProvider: getProviderNameForMetamask()
            });
          } else if (method === 'eth_sendTransaction') {
            logSendTransaction(params[0], result, {
              provider: (window as any).ethereum,
              type: 'injected',
              wallet: params[0].from,
              walletProvider: getProviderNameForMetamask()
            });
          } else  if (method === 'eth_sendSignedTransaction') {
            console.log("PF >>> DETECTED SEND SIGNED TRANSACTION MESSAGE");
          }
          return result;
        }
      }
    };
  },
};

const accountsChangedListener = (accounts: string[]) => {
  console.log("PF >>> Detected <accountsChanged> event.");
  console.log("PF >>> Accounts: ", accounts);
  logWalletConnect({
    provider: (window as any).ethereum,
    type: 'injected',
    wallet: accounts[0],
    walletProvider: getProviderNameForMetamask()
  });
}

async function addProviderListeners() {
  console.log("PF >>> Configuring provider listeners <message> and <accountsChanged>");
  const providers = await getProvider();
  for (let i = 0; i < providers.length; i++) {
    let providerResult = providers[i];
    if (providerResult.type === 'injected') {
      // accounts changed listener
      providerResult.provider.removeListener('accountsChanged', accountsChangedListener);
      providerResult.provider.on('accountsChanged', accountsChangedListener);
    }
  }
}

let URL_CHANGE_LISTENER_CALL_COUNT = 0;

function addUrlChangeListener() {
  // url changes listener
  let previousUrl = '';
  const observer = new MutationObserver(function(mutations) {
    if (location.href !== previousUrl) {
        console.log("PF >>> Logging user landed from path listener");
        console.log(`PF >>> previous_url: ${previousUrl} | new_url: ${location.href}`);
        previousUrl = location.href;
        URL_CHANGE_LISTENER_CALL_COUNT ++;
        console.log("PF >>> URL_CHANGE_LISTENER_CALL_COUNT", URL_CHANGE_LISTENER_CALL_COUNT);
        const path = location.href.replace(location.origin, "");
        console.log("PF >>> URL PATH", path);
        logUserLanded(path);
      }
  });
  const config = {subtree: true, childList: true};
  observer.observe(document, config);
}

function addLocalStorageListener() {
  const originalSetItem: any = localStorage.setItem;
  localStorage.setItem = function(key, value) {
    const event: any = new Event('itemInserted');
    event.key = key;
    event.value = value;
    document.dispatchEvent(event);
    originalSetItem.apply(this, arguments);
  };

  const localStorageSetHandler = async (e: any) => {
    if (e.key && e.key === 'walletconnect') {
      console.log("PF >>> Key is walletconnect!");
      if (localStorage.getItem(e.key) === e.value) {
        console.log("PF >>> identical walletconnect object was already stored in local storage. ignoring handler event...");
        return;
      }
      wcObject = JSON.parse(e.value);
      if (wcObject && wcObject.connected) {
        console.log(`PF >>> Logging walletconnect connect event...`);
        const provider = await wcObjectToWeb3Provider(wcObject);
        logWalletConnect({
          provider: provider,
          type: 'walletconnect',
          wallet: wcObject.accounts[0],
          walletProvider: wcObject.peerMeta.name.toLowerCase()
        });
      }
    }
  };

  document.addEventListener("itemInserted", localStorageSetHandler, false);
}

async function errorHandler(errorMsg: any, url: any, lineNo: any, columnNo: any, errorObj: any) {
  console.log("PF >>> Detected error...");
  console.log("PF >>> msg: ", errorMsg);
  console.log("PF >>> msg: ", url);
  console.log("PF >>> msg: ", lineNo);
  console.log("PF >>> msg: ", columnNo);
  console.log("PF >>> msg: ", errorMsg);
  let errorMessage = "";
  if (errorMsg) { errorMessage = `errorMsg=${errorMsg};`; }
  if (url) { errorMessage = `url=${url};`; }
  if (lineNo) { errorMessage = `lineNo=${lineNo};`; }
  if (columnNo) { errorMessage = `columnNo=${columnNo};`; }
  if (errorObj) { errorMessage = `errorObj=${errorObj.toString()};`; }
  logErrors([errorMessage]);
  return true;
}

async function logErrors(errors: string[]) {
  console.log("PF >>> Logging GENERIC_ERROR event");
  if (!checkShouldLogError(errors)) {
    console.log("PF >>> Ignoring GENERIC_ERROR event. Message already logged.");
    return;
  }
  const eventTracker: EventTracker = 'GENERIC_ERROR';
  const userId = getUserId();
  const sessionId = getSessionId();
  const utmParams = getUtmParams();
  const walletsList = await fetchWallet();

  const events = [];
  for (let i = 0; i < walletsList.length; i++) {
    const walletResult = walletsList[i];
    let chainState = {};
    if (walletResult) {
      chainState = await getChainState(walletResult) ?? {};
    }
    const deviceState = getDeviceState(walletResult);
    let eventData = {
      tracker: {
        eventTracker: eventTracker,
        userId: userId,
        sessionId: sessionId,
        origin: location.hostname,
        path: location.pathname,
        ...utmParams
      },
      device: deviceState,
      ...chainState,
      errors: errors
    }
    console.log("PF >>> Built GENERIC_ERROR event", eventData);
    events.push(eventData);
  }

  storeNewErrorEvent(errors);
  for (let i = 0; i < events.length; i++) {
    console.log("PF >>> Notifying gql server...");
    const response = await gqlClient.request(CreateErrorEvent, {
      event: events[i]
    });
    console.log("PF >>> Server notified. Response: ", response);
  }
}

async function logUserLanded(href: string | null = null) {
  console.log("PF >>> Logging USER_LANDED event");
  const eventTracker: EventTracker = 'USER_LANDED';
  const userId = getUserId();
  const sessionId = getSessionId();
  const utmParams = getUtmParams();

  const walletsList = await fetchWallet();
  let events = [];
  for (let i = 0; i < walletsList.length; i++) {
    const walletResult = walletsList[i];
    let chainState = {};
    if (walletResult) {
      chainState = await getChainState(walletResult) ?? {};
    }
  
    const deviceState = getDeviceState(walletResult);
    let eventData = {
      tracker: {
        eventTracker: eventTracker,
        userId: userId,
        sessionId: sessionId,
        origin: location.hostname,
        path: href ?? (location.pathname+location.search),
        ...utmParams
      },
      device: deviceState,
      ...chainState
    }
    console.log("PF >>> Built USER_LANDED event", eventData);
    events.push(eventData);
  }

  const paths = events.map(e => e.tracker.path).join(",");
  const wallets = events.map((e: any) => {
    if (e.wallet && e.wallet.walletAddress) {
      return e.wallet.walletAddress
    } else { return ""; }
  }).join(",");
  if (checkShouldLogLanded(wallets, paths)) {
    storeNewLandedEvent(wallets, paths);
    for (let i = 0; i < events.length; i++) {
      console.log("PF >>> Notifying gql server...");
      const response = await gqlClient.request(CreateUserLandedEvent, {
        event: events[i]
      });
      console.log("PF >>> Server notified. Response: ", response);
    }
  }
}

async function logWalletConnect(walletResult: WalletResponse) {
  console.log("PF >>> Logging WALLET_CONNECT event for wallet response", walletResult);
  const eventTracker: EventTracker = 'WALLET_CONNECT';
  const userId = getUserId();
  console.log("PF >>> userId", userId);
  const sessionId = getSessionId();
  console.log("PF >>> sessionId", sessionId);
  const utmParams = getUtmParams();
  console.log("PF >>> utmParams", utmParams);
  const chainState = await getChainState(walletResult);
  console.log("PF >>> chainState", chainState);
  const deviceState = getDeviceState(walletResult);
  console.log("PF >>> deviceState", deviceState);
  let eventData = {
    tracker: {
      eventTracker: eventTracker,
      userId: userId,
      sessionId: sessionId,
      origin: location.hostname,
      path: location.pathname,
      ...utmParams
    },
    device: deviceState,
    ...chainState
  }
  console.log("PF >>> Built WALLET_CONNECT event", eventData);
  console.log("PF >>> Notifying gql server...");
  const response = await gqlClient.request(CreateWalletConnectedEvent, {
    event: eventData
  });
  console.log("PF >>> Server notified. Response: ", response);
}

interface Tx {
  from: string;
  to: string;
  data: string;
  value?: string;
}
interface TxInfo {
  from: string,
  to?: string,
  value: string,
  input: string,
  nonce: string,
  gas: string,
  gasPrice: string, 
  maxFeePerGas?: string,
  maxPriorityFeePerGas?: string,
  v: string
  r: string,
  s: string,
  hash: string
}
async function logSendTransaction(tx: Tx, result: any, walletResult: WalletResponse) {
  console.log("PF >>> Logging TX_REQUEST event.");
  console.log("PF >>> Tx Data: ", tx);
  console.log("PF >>> Tx Send Result: ", result);
  const eventTracker: EventTracker = 'TX_REQUEST'; 
  const userId = getUserId();
  const sessionId = getSessionId();
  const utmParams = getUtmParams();
  const chainState = await getChainState(walletResult);
  const deviceState = getDeviceState(walletResult);
  const txHash = result as string;
  const fetchedTxInfo: TxInfo = await walletResult.provider.request(
    { method: 'eth_getTransactionByHash', params: [ txHash ] }
  );
  const maxFeePerGas = fetchedTxInfo.maxFeePerGas ? BigNumber.from(fetchedTxInfo.maxFeePerGas).toString() : null;
  const maxPriorityFeePerGas = 
    fetchedTxInfo.maxPriorityFeePerGas ? BigNumber.from(fetchedTxInfo.maxFeePerGas).toString() : null;
  
  let eventData = {
    tracker: {
      eventTracker: eventTracker,
      userId: userId,
      sessionId: sessionId,
      origin: location.hostname,
      path: location.pathname,
      ...utmParams
    },
    device: deviceState,
    ...chainState,
    tx: {
      from: fetchedTxInfo.from,
      to: fetchedTxInfo.to,
      value: BigNumber.from(fetchedTxInfo.value).toString(),
      input: fetchedTxInfo.input,
      nonce: BigNumber.from(fetchedTxInfo.nonce).toString(),
      gas: BigNumber.from(fetchedTxInfo.gas).toString(),
      gasPrice: BigNumber.from(fetchedTxInfo.gasPrice).toString(),
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: maxPriorityFeePerGas,
      v: fetchedTxInfo.v,
      r: fetchedTxInfo.r,
      s: fetchedTxInfo.s,
      hash: txHash,
      status: TxStatus.PENDING
    }
  }
  console.log("PF >>> Built TX_REQUEST event", eventData);
  console.log("PF >>> Notifying gql server...");
  const response = await gqlClient.request(CreateTxRequestEvent, {
    event: eventData
  });
  console.log("PF >>> Server notified. Response: ", response);
  
  const receipt = await waitMined(eventData, walletResult.provider);
  console.log("PF >>> receipt: ", receipt);
  if (receipt) {
    console.log("PF >>> Notifying gql server about transaction status update...");
    const updateResponse = await gqlClient.request(UpdateTxRequestEventTxStatus, {
      id: response.createTxRequestEvent.id,
      newStatus: receipt.status
    });
    console.log("PF >>> Server notified about transaction status update. Response: ", updateResponse);
  }
}

function getUserId(): string {
  let userId = localStorage.getItem(PF_SDK_USER_KEY);
  if (userId) {
    return userId;
  } else {
    userId = crypto.randomUUID();
    localStorage.setItem(PF_SDK_USER_KEY, userId);
    return userId;
  }
}

function getSessionId(): string {
  let sessionId = sessionStorage.getItem(PF_SDK_SESSION_KEY);
  if (sessionId) {
    return sessionId
  } else {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(PF_SDK_SESSION_KEY, sessionId);
    return sessionId;
  } 
}

function checkShouldLogError(errors: string[]): boolean {
  const lastLoggedErrorsStringified = sessionStorage.getItem(PF_LAST_ERROR_LOGGED_KEY) ?? "";
  const newErrorsStringified = JSON.stringify(errors);
  
  return newErrorsStringified != lastLoggedErrorsStringified;
}
function storeNewErrorEvent(errors: string[]) {
  sessionStorage.setItem(
    PF_LAST_ERROR_LOGGED_KEY,
    JSON.stringify(errors)
  );
}

function checkShouldLogLanded(wallets: string, paths: string): boolean {
  const lastLoggedUserLandedWallet = sessionStorage.getItem(PF_LAST_USER_LANDED_WALLET_KEY) ?? "";
  const lastLoggedUserLandedPath = sessionStorage.getItem(PF_LAST_USER_LANDED_PATH_KEY) ?? "";
  
  return (wallets != lastLoggedUserLandedWallet || paths != lastLoggedUserLandedPath);
}
function storeNewLandedEvent(wallets: string, paths: string) {
  sessionStorage.setItem(PF_LAST_USER_LANDED_WALLET_KEY, wallets);
  sessionStorage.setItem(PF_LAST_USER_LANDED_PATH_KEY, paths);
}

interface WCObject {
  connected: boolean,
  accounts: string[],
  chainId: number,
  bridge: string,
  key: string,
  clientId: string,
  clientMeta: {
    name: string,
    description: string,
    url: string,
    icons: string[]
  },
  peerId: string,
  peerMeta: {
    name: string,
    description: string,
    url: string,
    icons: string[]
  },
  handshakeId: number,
  handshakeTopic: string
}
function fetchWcObjet() {
  console.log("PF >>> fetching wc object");
  const wc = localStorage.getItem('walletconnect');
  if (wc) {
    console.log("PF >>> fetched wc object", wc);
    wcObject = JSON.parse(wc);
    console.log("PF >>> parsed wc object", wcObject);
  } else {
    console.log("PF >>> failed to fetch wc object. Wc: ", wc);
  }
}

interface WalletResponse {
  type: ProviderType,
  provider: any,
  wallet: string,
  walletProvider: string
}
async function fetchWallet(): Promise<WalletResponse[]> {
  const providerResult = await getProvider()

  const result: WalletResponse[] = [];
  for (let i = 0; i < providerResult.length; i++) {
    const p = providerResult[i];
    if(p.type === 'walletconnect') {
      if (!wcObject) continue;
      result.push({
        type: p.type,
        wallet: wcObject.accounts[0],
        walletProvider: wcObject.peerMeta.name.toLowerCase(),
        provider: p.provider
      })
    } else {
      const accounts: string = await p.provider.request(
        { method: 'eth_accounts' }
      );
      if (!accounts || accounts.length === 0) { continue; }
      result.push({
        type: p.type,
        wallet: accounts[0],
        walletProvider: getProviderNameForMetamask(),
        provider: p.provider
      });
    }
  }
  return result;
}

interface ChainState {
  wallet: {
    walletAddress: string,
    gasBalance: string,
    nonce: string,
    networkId: number
  },
  network: {
    chainId: number,
    blockHeight: string,
    gasPrice: string
  }
}
async function getChainState(walletResult: WalletResponse): Promise<ChainState | null> {
  const provider = walletResult.provider;

  const getBalanceResponse = await provider.request(
    {
      method: 'eth_getBalance',
      params: [ walletResult.wallet, 'latest' ]
    }
  );
  console.log("PF >>> getBalanceResponse", getBalanceResponse);
  const gasBalance = BigNumber.from(getBalanceResponse).toString();
  
  const nonceResponse = await provider.request(
    {
      method: 'eth_getTransactionCount',
      params: [ walletResult.wallet, 'latest' ]
    }
  ); 
  console.log("PF >>> nonceResponse", nonceResponse);
  const nonce = BigNumber.from(nonceResponse).toString();
  
  const networkIdResponse = await provider.request({method: 'eth_chainId'});
  console.log("PF >>> chainIdResponse", networkIdResponse);
  const networkId = BigNumber.from(networkIdResponse).toNumber();
  
  const blockHeightResponse = await provider.request(
    { method: 'eth_blockNumber' }
  );
  console.log("PF >>> blockHeightResponse", blockHeightResponse);
  const blockHeight = 
    BigNumber.from(blockHeightResponse).toString();

  const gasPriceResponse = await provider.request({method: 'eth_gasPrice'});
  console.log("PF >>> gasPriceResponse", gasPriceResponse);
  const gasPrice = BigNumber.from(gasPriceResponse).toString();
  
  const chainState = {
    wallet: {
      walletAddress: walletResult.wallet,
      gasBalance: gasBalance,
      nonce: nonce,
      networkId: networkId
    },
    network: {
      chainId: networkId,
      gasPrice: gasPrice,
      blockHeight: blockHeight
    }
  };
  return chainState;
}

interface UtmParams {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
}

function storeUtmParams() {
  console.log("PF >>> Storing UTM params");
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(urlSearchParams.entries());
  const paramsObject = {
    utmSource: params.utm_source,
    utmMedium: params.utm_medium,
    utmCampaign: params.utm_campaign,
    utmContent: params.utm_content,
    utmTerm: params.utm_term
  }
  const paramsObjectStringified = JSON.stringify(paramsObject);
  sessionStorage.setItem(PF_SDK_UTM_KEY, paramsObjectStringified);
}

function getUtmParams(): UtmParams {
  const paramsObject = JSON.parse(sessionStorage.getItem(PF_SDK_UTM_KEY) ?? "{}");
  return paramsObject;
}

interface ScreenState {
  w: number,
  h: number
}

interface DeviceState {
  os?: string,
  browser?: string,
  country?: string,
  screen?: ScreenState,
  walletProvider: string,
  walletType: string
}

function getDeviceState(walletResult: WalletResponse | null): DeviceState {
  const userAgent = window.navigator.userAgent;
  const parsedUserAgent = uaParser(userAgent);

  let userCountry = "unknown";
  if (Intl) {
    const tzArr = Intl.DateTimeFormat().resolvedOptions().timeZone.split("/");
    const userCity: string = tzArr[tzArr.length - 1];
    userCountry = (timeZoneCityToCountry as any)[userCity] ?? "unknown";
  }
  
  return {
    os: parsedUserAgent.os.name,
    browser: parsedUserAgent.browser.name,
    country: userCountry,
    screen: {
      w: screen.width,
      h: screen.height
    },
    walletType: walletResult?.type ?? 'unknown',
    walletProvider: walletResult?.walletProvider ?? 'unknown'
  };
}

type ProviderName = 
                'metamask'      | 
                'trust'         | 
                'gowallet'      |
                'alphawallet'   |  
                'status'        |
                'coinbase'      |
                'cipher'        |
                'mist'          |
                'parity'        |
                'infura'        |
                'localhost'     |
                'walletconnect' |
                'unknown';

function getProviderNameForMetamask(): ProviderName {
  const fetchedProvider = (window as any).ethereum;
  if (fetchedProvider.isMetaMask) return 'metamask';
  if (fetchedProvider.isTrust) return 'trust';
  if (fetchedProvider.isGoWallet) return 'gowallet';
  if (fetchedProvider.isAlphaWallet) return 'alphawallet';
  if (fetchedProvider.isStatus) return 'status';
  if (fetchedProvider.isToshi) return 'coinbase';
  if (typeof (window as any).__CIPHER__ !== 'undefined') return 'cipher';
  if (fetchedProvider.constructor.name === 'EthereumProvider') return 'mist';
  if (fetchedProvider.constructor.name === 'Web3FrameProvider') return 'parity';
  if (fetchedProvider.host && fetchedProvider.host.indexOf('infura') !== -1) return 'infura';
  if (fetchedProvider.host && fetchedProvider.host.indexOf('localhost') !== -1) return 'localhost';
  return 'unknown';
}

type ProviderType = "injected" | "walletconnect";
interface ProviderResult {
  type: ProviderType,
  provider: any
}
async function getProvider(): Promise<ProviderResult[]> {
  console.log("PF >>> getProvider() call");

  const providers: ProviderResult[] = [];
  if (wcObject) {
    console.log("PF >>> Detected walletconnect provider...")
    providers.push({
      type: "walletconnect",
      provider: await wcObjectToWeb3Provider(wcObject)
    });
  }
  
  if ((window as any).ethereum) {
    console.log("PF >>> Detected window.ethereum provider...")
    providers.push({
      type: "injected",
      provider: (window as any).ethereum
    });
  } else if ((window as any).web3 && (window as any).web3.currentProvider) {
    console.log("PF >>> Detected window.web3.currentProvider provider...")
    providers.push({
      type: "injected",
      provider: (window as any).web3.currentProvider
    });
  } else {
    console.log("PF >>> Missing provider!");
  }

  return providers;
}

async function wcObjectToWeb3Provider(wcObject: WCObject): Promise<any> {
  console.log("PF >> wc object to web3 provider")
  const rpcsMap = new Map<number, string>([
    [1, "https://eth.llamarpc.com"],
    [5, "https://endpoints.omniatech.io/v1/eth/goerli/public"],
    [10, "https://endpoints.omniatech.io/v1/op/mainnet/public"],
    [25, "https://cronos-evm.publicnode.com"],
    [56, "https://bsc.publicnode.com"],
    [100, "https://rpc.gnosischain.com"],
    [137, "https://polygon.llamarpc.com"],
    [250, "https://fantom.publicnode.com"],
    [420, "https://goerli.optimism.io"],
    [1284, "https://moonbeam.public.blastapi.io"],
    [1285, "https://rpc.api.moonriver.moonbeam.network"],
    [2222, "https://evm.kava.io"],
    [4002, "https://rpc.testnet.fantom.network/"],
    [7700, "https://canto.neobase.one"],
    [8217, "https://public-node-api.klaytnapi.com/v1/cypress"],
    [42161, "https://endpoints.omniatech.io/v1/arbitrum/one/public"],
    [42170, "https://nova.arbitrum.io/rpc"],
    [42220, "https://forno.celo.org"],
    [43114, "https://avalanche-c-chain.publicnode.com"],
    [80001, "https://endpoints.omniatech.io/v1/matic/mumbai/public"],
    [421613, "https://goerli-rollup.arbitrum.io/rpc"],
    [11155111, "https://rpc.sepolia.dev"],
    [1313161554, "https://endpoints.omniatech.io/v1/aurora/mainnet/public"]
  ]);
  const chainId = wcObject.chainId;
  const rpc = rpcsMap.get(chainId);
  if (!rpc) { return null; }
  const provider = new Web3HttpProvider(rpc);
  return provider;
}

enum TxStatus {
  PENDING = "PENDING",
  SUCCESS = "SUCCESS",
  FAILURE = "FAILURE"
}
interface TxReceipt {
  blockNumber: string,
  status?: TxStatus
}
async function waitMined(
  eventData: any,
  provider: any,
  retries: number = 50,
  pollIntervalSeconds: number = 5
): Promise<TxReceipt | null> {
  const txHash = eventData.tx.hash;
  console.log(`PF >>> Waiting tx minded for hash ${txHash}`);
  let attempts = 0;
  while(attempts < retries) {
    console.log(`PF >>> Attempt ${attempts} to fetch the receipt...`);
    const receipt = await provider.request({method: "eth_getTransactionReceipt", params: [txHash]});
    console.log(`PF >>> Receipt fetched: `, receipt);
    if (receipt && receipt.blockNumber) {
      const status = receipt.status;
      console.log(`PF >>> Transaction included in block ${receipt.blockNumber}. Transaction status is ${status}!`);
      return {
        blockNumber: receipt.blockNumber,
        status: (status === "0x0") ? TxStatus.FAILURE : TxStatus.SUCCESS
      }
    }
    await sleep(pollIntervalSeconds * 1000);
    attempts++;
  }
  console.log(`PF >>> Waiting for transaction timed out...`);
  return null;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
