import { BigNumber } from '@ethersproject/bignumber';
import { AwesomeGraphQLClient } from 'awesome-graphql-client';
import * as encoding from '@walletconnect/encoding';
import * as isoCrypto from '@walletconnect/crypto';
import * as timeZoneCityToCountry from '../localization/tz-cities-to-countries.json';
import HttpProvider from 'web3-providers-http';
import { JsonRpcResponse } from 'web3-core-helpers';
import uaParser from 'ua-parser-js';
import { aes256gcmDecrypt } from '../util/aes256gcm';

class Web3HttpProvider extends HttpProvider {
  async request(payload: any): Promise<JsonRpcResponse | null> {
    return new Promise((resolve, reject) => {
      this.send(
        {
          ...payload,
          id: 1,
          jsonrpc: '2.0',
        },
        (err, result) => {
          if (err) {
            reject(err);
          }
          resolve(result?.result);
        }
      );
    });
  }
}

const PF_SDK_SESSION_KEY = 'PF_SDK_SESSION_KEY';
const PF_SDK_USER_KEY = 'PF_SDK_USER_KEY';
const PF_SDK_UTM_KEY = 'PF_SDK_UTM_KEY';
const PF_EVENTS_HASH_MAP = 'PF_EVENTS_HASH_MAP';
const MIN_TIME_DIFF_FOR_EVENT_LOG_MS = 1000;

type EventTracker =
  | 'WALLET_CONNECT'
  | 'USER_LANDED'
  | 'TX_REQUEST'
  | 'GENERIC_ERROR';

const CreateUserLandedEvent = `
  mutation CreateUserLandedEvent($event: UserLandedEventInput!) {
    createUserLandedEvent(event: $event) {
      id,
      tracker {
        userId
      }
    }
  }
`;

const CreateWalletConnectedEvent = `
  mutation CreateWalletConnectedEvent($event: WalletConnectedEventInput!) {
    createWalletConnectedEvent(event: $event) {
      id,
      tracker {
        userId
      }
    }
  }
`;

const CreateTxRequestEvent = `
  mutation CreateTxRequestEvent($event: TxRequestEventInput!) {
    createTxRequestEvent(event: $event) {
      id,
      tracker {
        userId
      }
    }
  }
`;

const UpdateTxRequestEventTxStatus = `
  mutation UpdateTxRequestEventTxStatus($id: UUID!, $newStatus: TxStatus!) {
    updateTxRequestEventTxStatus(id: $id, newStatus: $newStatus) {
      id,
      tracker {
        userId
      }
    }
  }
`;

const CreateErrorEvent = `
  mutation CreateErrorEvent($event: ErrorEventInput!) {
    createErrorEvent(event: $event) {
      id,
      tracker {
        userId
      }
    }
  }
`;

const CreateBlockchainErrorEvent = `
  mutation CreateBlockchainErrorEvent($event: BlockchainErrorEventInput!) {
    createBlockchainErrorEvent(event: $event) {
      id
    }
  }
`;

enum Environment {
  STAGING = 'https://backend-staging.polyflow.dev/api/graphql',
  PROD = 'https://backend-prod.polyflow.dev/api/graphql',
}

let proxy: any;
let provider = (window as any).ethereum;
let gqlClient: AwesomeGraphQLClient;
let LOG_ENABLED: boolean = false;
let wcObject: WCObject | null = null;
let cbObject: CbObject | null = null;
let chainlist: Map<string, string> = new Map();

interface AttachOptions {
  logEnabled?: boolean;
  stagingModeEnabled?: boolean;
  gqlApi?: string;
}
export async function attach(apiKey: string, options?: AttachOptions) {
  let gqlApi: string = Environment.PROD;
  if (options) {
    if (options.gqlApi) {
      gqlApi = options.gqlApi;
    } else {
      if (options.stagingModeEnabled === true) {
        gqlApi = Environment.STAGING;
      }
    }
  }

  gqlClient = new AwesomeGraphQLClient({
    endpoint: gqlApi,
    fetchOptions: {
      headers: {
        'X-API-KEY': apiKey,
      },
    },
  });

  LOG_ENABLED = options ? options.logEnabled === true : false;

  await fetchChainlist();
  storeUtmParams();
  fetchWcObject();
  fetchCbObject();
  addUrlChangeListener();
  addLocalStorageListener();
  initializeProviderProxy();
  initializeWsProxy();
  addProviderListeners();
  logUserLanded();

  window.onerror = errorHandler;
  window.onunhandledrejection = function (errorEvent) {
    pfLog('PF >>> uhandled rjection: ', errorEvent);
    let errors: string[] = [];
    if (errorEvent.reason) {
      if (errorEvent.reason.message) {
        errors.push(errorEvent.reason.message.toString());
      }
      if (errorEvent.reason.stack) {
        errors.push(errorEvent.reason.stack.toString());
      }
      logErrors(errors);
    } else {
      logErrors([JSON.stringify(errorEvent)]);
    }
  };
  return window.origin;
}

async function fetchChainlist() {
  const chainlistResponse = await fetch(
    'https://raw.githubusercontent.com/0xpolyflow/polyflow-sdk/master/resources/chainlist.json'
  );
  const chainlistJson = await chainlistResponse.json();
  pfLog('PF >>> Fetched chainlist json', chainlistJson);
  chainlist = new Map(Object.entries(chainlistJson));
}

const wsMessages = new Map<string, any>([]);
export function initializeWsProxy() {
  pfLog('PF >>> Initializing ws proxy...');
  const OriginalWebsocket = (window as any).WebSocket;
  const ProxiedWebSocket = function () {
    const ws = new OriginalWebsocket(...arguments);

    // incoming messages
    ws.addEventListener('message', async (e: any) => {
      pfLog('PF >>> Intercepted incoming ws message', e.data);
      const messageObj = JSON.parse(e.data);
      if (!messageObj) {
        pfLog(
          'PF >>> Could not parse ws message. Giving up on processing ws message: ',
          e.data
        );
        return;
      }
      pfLog('PF >>> Parsed ws message to object: ', messageObj);
      if (messageObj.payload && messageObj.topic === wcObject?.clientId) {
        if (!wcObject) {
          pfLog(
            'PF >>> Could not fetch wc object. Giving up on processing ws message: ',
            e.data
          );
          return;
        }
        pfLog('PF >>> Message is a walletconnect message');
        const payload = JSON.parse(messageObj.payload);
        if (!payload) {
          pfLog('PF >>> Could not parse payload:', messageObj.payload);
          return;
        }
        pfLog('PF >>> Parsed payload: ', payload);
        const decrypted = await decrypt(payload, wcObject);
        if (decrypted.id && wsMessages.has(decrypted.id)) {
          pfLog(
            'PF >>> Payload is a response to an eth_sendTransaction message'
          );
          const txData = wsMessages.get(decrypted.id);
          pfLog('PF >>> Transaction data: ', txData);
          if (decrypted.error) {
            pfLog(
              'PF >>> Transaction not sent! RPC error detected: ',
              decrypted.error
            );
            if (
              decrypted.error.message &&
              decrypted.error.message.includes('rejected')
            ) {
              pfLog('PF >>> Transaction was rejected by user!');
              logSendTransaction(txData, TxStatus.CANCELLED, null, {
                provider: await chainIdToWeb3Provider(wcObject.chainId),
                type: 'walletconnect',
                wallet: txData.from.toLowerCase(),
                walletProvider: wcObject.peerMeta.name.toLowerCase(),
              });
            }
          } else {
            const hash = decrypted.result;
            pfLog('PF >>> Transaction hash: ', hash);
            logSendTransaction(txData, TxStatus.PENDING, hash, {
              provider: await chainIdToWeb3Provider(wcObject.chainId),
              type: 'walletconnect',
              wallet: txData.from.toLowerCase(),
              walletProvider: wcObject.peerMeta.name.toLowerCase(),
            });
          }
        } else {
          pfLog(
            'PF >>> Payload is not a response to eth_sendTransaction message...'
          );
        }
      } else if (
        messageObj.type === 'Event' &&
        messageObj.event === 'Web3Response' &&
        messageObj.data
      ) {
        pfLog('PF >>> Message is a coinbase message');
        if (!cbObject) {
          pfLog(
            'PF >>> Could not fetch cb object. Giving up on decrypting data: ',
            messageObj.data
          );
          return;
        }
        const decrypted = JSON.parse(
          await aes256gcmDecrypt(messageObj.data, cbObject.sessionSecret)
        );
        pfLog('PF >>> Decrypted coinbase message: ', decrypted);
        if (decrypted.id && wsMessages.has(decrypted.id)) {
          pfLog(
            'PF >>> Payload is a response to an coinbase signEthereumTransaction message with broadcast=true'
          );
          const txData = wsMessages.get(decrypted.id);
          pfLog('PF >>> Transaction data: ', txData);
          if (decrypted.response.errorMessage) {
            // transaction not broadcasted (error)
            pfLog(
              'PF >>> Transaction not sent! RPC error detected: ',
              decrypted.response.errorMessage
            );
            if (decrypted.response.errorMessage.includes('rejected')) {
              pfLog('PF >>> Transaction was rejected by user!');
              logSendTransaction(txData, TxStatus.CANCELLED, null, {
                provider: await chainIdToWeb3Provider(txData.chainId),
                type: 'coinbase',
                wallet: txData.from.toLowerCase(),
                walletProvider: 'coinbase',
              });
            }
          } else {
            const hash = decrypted.response.result;
            pfLog('PF >>> Transaction hash: ', hash);
            logSendTransaction(txData, TxStatus.PENDING, hash, {
              provider: await chainIdToWeb3Provider(txData.chainId),
              type: 'coinbase',
              wallet: txData.from.toLowerCase(),
              walletProvider: 'coinbase',
            });
          }
        }
      } else {
        pfLog('PF >>> Message not recognized!');
      }
    });

    // outgoing messages
    const originalSend = ws.send;
    const proxiedSend = function () {
      try {
        pfLog('PF >>> Intercepted outgoing ws message', arguments);
        const messageObj = JSON.parse(arguments[0]);
        if (!messageObj) {
          pfLog(
            'PF >>> Could not parse ws message. Giving up on processing ws message: ',
            arguments[0]
          );
          return originalSend.apply(this, arguments);
        }

        pfLog('PF >>> Parsed ws message to object: ', messageObj);
        if (messageObj.payload && messageObj.topic === wcObject?.peerId) {
          pfLog('PF >>> Message is a walletconnect message');
          if (!wcObject) {
            pfLog(
              'PF >>> Could not fetch wc object. Giving up on processing ws message: ',
              arguments[0]
            );
            return originalSend.apply(this, arguments);
          }
          const payload = JSON.parse(messageObj.payload);
          if (!payload) {
            pfLog('PF >>> Could not parse payload:', messageObj.payload);
            return originalSend.apply(this, arguments);
          }
          pfLog('PF >>> Parsed payload: ', payload);
          decrypt(payload, wcObject).then((decrypted) => {
            if (
              decrypted.id &&
              decrypted.method &&
              decrypted.method === 'eth_sendTransaction'
            ) {
              pfLog(
                'PF >>> Payload is eth_sendTransaction request with id: ',
                decrypted.id
              );
              const params = decrypted.params[0];
              pfLog('PF >>> Storing tx params object: ', params);
              wsMessages.set(decrypted.id, params);
            } else {
              pfLog('PF >>> Payload not eth_sendTransaction: ', decrypted);
            }
          });
        } else if (
          messageObj.type === 'PublishEvent' &&
          messageObj.event === 'Web3Request' &&
          messageObj.data
        ) {
          pfLog('PF >>> Message is a coinbase message');
          if (!cbObject) {
            pfLog(
              'PF >>> Could not fetch coinbase object. Giving up on processing coinbase message: ',
              messageObj.data
            );
            return originalSend.apply(this, arguments);
          }
          aes256gcmDecrypt(messageObj.data, cbObject.sessionSecret).then(
            (decryptedString) => {
              const decrypted = JSON.parse(decryptedString);
              if (decrypted.id && decrypted.type === 'WEB3_REQUEST') {
                pfLog(
                  'PF >>> Payload is a coinbase WEB3_REQUEST request with id: ',
                  decrypted.id
                );
                const requestObj = decrypted.request;
                if (
                  requestObj &&
                  requestObj.method === 'signEthereumTransaction'
                ) {
                  pfLog(
                    'PF >>> Payload is a coinbase WEB3_REQUEST signEthereumTransaction with params: ',
                    requestObj.params
                  );
                  const params = requestObj.params;
                  pfLog('PF >>> Should submit tx: ', params.shouldSubmit);
                  if (params.shouldSubmit) {
                    pfLog('PF >>> Storing tx params object');
                    wsMessages.set(decrypted.id, {
                      from: params.fromAddress,
                      to: params.toAddress,
                      data: params.data,
                      value: params.weiValue,
                      chainId: params.chainId,
                    });
                  }
                }
              } else {
                pfLog('PF >>> Payload not eth_sendTransaction: ', decrypted);
              }
              pfLog('PF >>> Decrypted message: ', decrypted);
            }
          );
        } else {
          pfLog('PF >>> Message is not a walletconnect message');
        }

        return originalSend.apply(this, arguments);
      } catch (error) {
        pfLog('PF >>> Error handling websocked connection: ', error);
        return originalSend.apply(this, arguments);
      }
    };
    ws.send = proxiedSend;
    return ws;
  };
  (window as any).WebSocket = ProxiedWebSocket;
}

interface Payload {
  data: string;
  hmac: string;
  iv: string;
}
async function decrypt(payload: Payload, wcObject: WCObject): Promise<any> {
  pfLog('PF >>> Decrypting payload: ', payload);
  pfLog('PF >>> with wc object: ', wcObject);

  const key = encoding.hexToArray(wcObject.key);
  const iv = encoding.hexToArray(payload.iv);
  const data = encoding.hexToArray(payload.data);

  const decrypted = await isoCrypto.aesCbcDecrypt(iv, key, data);
  const decryptedString = encoding.arrayToUtf8(decrypted);
  pfLog('PF >>> Decrypted data: ', decryptedString);
  return JSON.parse(decryptedString);
}

function initializeProviderProxy() {
  Object.defineProperty(window, 'ethereum', {
    get() {
      pfLog('PF >>> provider get!');
      if (!proxy && provider) {
        proxy = new Proxy(provider, handler);
        provider = undefined;
        pfLog('PF >>> am attached!]');
        pfLog('PF >>> proxy data: ', proxy);
      }
      return proxy;
    },
    set(newProvider) {
      pfLog('PF >>> provider set!');
      proxy = new Proxy(newProvider, handler);
      pfLog('PF >>> proxy data: ', proxy);
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

      pfLog('PF >>> Intercepted method: ', method);
      pfLog('PF >>> With params: ', params);

      /* eslint-disable no-fallthrough */
      switch (method) {
        default: {
          try {
            const result = await Reflect.get(target, prop, receiver)(...args);
            pfLog(
              'PF >>> Executed method on target object with result: ',
              result
            );
            if (method === 'eth_requestAccounts') {
              logWalletConnect({
                provider: (window as any).ethereum,
                type: 'injected',
                wallet: result[0].toLowerCase(),
                walletProvider: getProviderNameForMetamask(),
              });
            } else if (method === 'eth_sendTransaction') {
              logSendTransaction(params[0], TxStatus.PENDING, result, {
                provider: (window as any).ethereum,
                type: 'injected',
                wallet: params[0].from.toLowerCase(),
                walletProvider: getProviderNameForMetamask(),
              });
            } else if (method === 'eth_sendSignedTransaction') {
              pfLog('PF >>> DETECTED SEND SIGNED TRANSACTION MESSAGE');
            }
            return result;
          } catch (err: any) {
            pfLog('PF >>> Error when sending transaction: ', err);
            if (err.code && err.code == 4001) {
              pfLog('PF >>> User rejected transaction!');
              logSendTransaction(params[0], TxStatus.CANCELLED, null, {
                provider: (window as any).ethereum,
                type: 'injected',
                wallet: params[0].from.toLowerCase(),
                walletProvider: getProviderNameForMetamask(),
              });
            }
          }
        }
      }
    };
  },
};

const accountsChangedListener = (accounts: string[]) => {
  pfLog('PF >>> Detected <accountsChanged> event.');
  pfLog('PF >>> Accounts: ', accounts);
  logWalletConnect({
    provider: (window as any).ethereum,
    type: 'injected',
    wallet: accounts[0].toLowerCase(),
    walletProvider: getProviderNameForMetamask(),
  });
};

async function addProviderListeners() {
  pfLog(
    'PF >>> Configuring provider listeners <message> and <accountsChanged>'
  );
  const providers = await getProvider();
  for (let i = 0; i < providers.length; i++) {
    let providerResult = providers[i];
    if (providerResult.type === 'injected') {
      // accounts changed listener
      providerResult.provider.removeListener(
        'accountsChanged',
        accountsChangedListener
      );
      providerResult.provider.on('accountsChanged', accountsChangedListener);
    }
  }
}

function addUrlChangeListener() {
  // url changes listener
  let previousUrl = '';
  const observer = new MutationObserver(function (mutations) {
    if (location.href !== previousUrl) {
      pfLog('PF >>> Logging user landed from path listener');
      pfLog(`PF >>> previous_url: ${previousUrl} | new_url: ${location.href}`);
      previousUrl = location.href;
      const path = location.href.replace(location.origin, '');
      pfLog('PF >>> URL PATH', path);
      logUserLanded(path);
    }
  });
  const config = { subtree: true, childList: true };
  observer.observe(document, config);
}

function addLocalStorageListener() {
  const originalSetItem: any = localStorage.setItem;
  localStorage.setItem = function (key, value) {
    const event: any = new Event('itemInserted');
    event.key = key;
    event.value = value;
    document.dispatchEvent(event);
    originalSetItem.apply(this, arguments);
  };

  const localStorageSetHandler = async (e: any) => {
    if (e.key && e.key === 'walletconnect') {
      pfLog('PF >>> Key is walletconnect!');
      if (localStorage.getItem(e.key) === e.value) {
        pfLog(
          'PF >>> identical walletconnect object was already stored in local storage. ignoring handler event...'
        );
        return;
      }
      wcObject = JSON.parse(e.value);
      if (wcObject && wcObject.connected) {
        pfLog(`PF >>> Logging walletconnect connect event...`);
        const provider = await chainIdToWeb3Provider(wcObject.chainId);
        logWalletConnect({
          provider: provider,
          type: 'walletconnect',
          wallet: wcObject.accounts[0].toLowerCase(),
          walletProvider: wcObject.peerMeta.name.toLowerCase(),
        });
      }
    } else if (e.key === '-walletlink:https://www.walletlink.org:Addresses') {
      pfLog('PF >>> Key is coinbase - Addresses = ', e.value);
      fetchCbObject(e.value);
      if (cbObject) {
        const oldAddressesValue = (
          localStorage.getItem(
            '-walletlink:https://www.walletlink.org:Addresses'
          ) ?? ''
        ).toString();
        const newAddressesValue = e.value.toString();
        pfLog('PF >>> Old addresses value: ', oldAddressesValue);
        pfLog('PF >>> New addresses value: ', newAddressesValue);
        if (
          newAddressesValue.length > 0 &&
          newAddressesValue !== oldAddressesValue
        ) {
          cbObject.addresses = newAddressesValue;
          logWalletConnect({
            provider: new Web3HttpProvider(cbObject.defaultJsonRpcUrl),
            type: 'coinbase',
            wallet: cbObject.addresses.toLowerCase(),
            walletProvider: 'coinbase',
          });
        }
      }
    }
  };

  document.addEventListener('itemInserted', localStorageSetHandler, false);
}

async function errorHandler(
  errorMsg: any,
  url: any,
  lineNo: any,
  columnNo: any,
  errorObj: any
) {
  pfLog('PF >>> Detected error...');
  pfLog('PF >>> msg: ', errorMsg);
  pfLog('PF >>> msg: ', url);
  pfLog('PF >>> msg: ', lineNo);
  pfLog('PF >>> msg: ', columnNo);
  pfLog('PF >>> msg: ', errorMsg);
  let errorMessage = '';
  if (errorMsg) {
    errorMessage = `errorMsg=${errorMsg};`;
  }
  if (url) {
    errorMessage = `url=${url};`;
  }
  if (lineNo) {
    errorMessage = `lineNo=${lineNo};`;
  }
  if (columnNo) {
    errorMessage = `columnNo=${columnNo};`;
  }
  if (errorObj) {
    errorMessage = `errorObj=${errorObj.toString()};`;
  }
  logErrors([errorMessage]);
  return true;
}

async function logErrors(errors: string[]) {
  try {
    pfLog('PF >>> Logging GENERIC_ERROR event');
    const eventTracker: EventTracker = 'GENERIC_ERROR';
    const userId = getUserId();
    const sessionId = getSessionId();
    const utmParams = getUtmParams();
    const walletsList = await fetchWallet();
    const urlParts = splitPathAndQuery(location.pathname);
  
    const events = [];
    if (walletsList.length === 0) {
      const chainState = {};
      const deviceState = getDeviceState(null);
      let referrer = null;
      if (document.referrer) {
        pfLog('PF >>> Referrer: ', document.referrer);
        referrer = document.referrer;
      }
      let eventData = {
        tracker: {
          eventTracker: eventTracker,
          userId: userId,
          sessionId: sessionId,
          origin: location.hostname,
          referrer: referrer,
          path: urlParts.path,
          query: urlParts.query,
          ...utmParams,
        },
        device: deviceState,
        ...chainState,
        errors: errors,
      };
      pfLog('PF >>> Built GENERIC_ERROR event', eventData);
      events.push(eventData);
    } else {
      for (let i = 0; i < walletsList.length; i++) {
        const walletResult = walletsList[i];
        let chainState = (await getChainState(walletResult)) ?? {};
        const deviceState = getDeviceState(walletResult);
        let referrer = null;
        if (document.referrer) {
          pfLog('PF >>> Referrer: ', document.referrer);
          referrer = document.referrer;
        }
        let eventData = {
          tracker: {
            eventTracker: eventTracker,
            userId: userId,
            sessionId: sessionId,
            origin: location.hostname,
            referrer: referrer,
            path: urlParts.path,
            query: urlParts.query,
            ...utmParams,
          },
          device: deviceState,
          ...chainState,
          errors: errors,
        };
        pfLog('PF >>> Built GENERIC_ERROR event', eventData);
        events.push(eventData);
      }
    }
  
    for (let i = 0; i < events.length; i++) {
      if (checkShouldLogEvent(events[i])) {
        pfLog('PF >>> Notifying gql server...');
        const response = await gqlClient.request(CreateErrorEvent, {
          event: events[i],
        });
        pfLog('PF >>> Server notified. Response: ', response);
        setUserId(response.createErrorEvent.tracker.userId);
      }
    }
  } catch(err) {
    pfLog('PF >>> GENERIC_ERROR err', err);
  }
}

async function logUserLanded(href: string | null = null) {
  try {
    pfLog('PF >>> Logging USER_LANDED event');
    const eventTracker: EventTracker = 'USER_LANDED';
    const userId = getUserId();
    const sessionId = getSessionId();
    const utmParams = getUtmParams();
    const urlParts = splitPathAndQuery(
      href ?? location.pathname + location.search
    );
    const walletsList = await fetchWallet();
    let events = [];
  
    if (walletsList.length === 0) {
      const chainState = {};
      const deviceState = getDeviceState(null);
      let referrer = null;
      if (document.referrer) {
        pfLog('PF >>> Referrer: ', document.referrer);
        referrer = document.referrer;
      }
      let eventData = {
        tracker: {
          eventTracker: eventTracker,
          userId: userId,
          sessionId: sessionId,
          origin: location.hostname,
          referrer: referrer,
          path: urlParts.path,
          query: urlParts.query,
          ...utmParams,
        },
        device: deviceState,
        ...chainState,
      };
      pfLog('PF >>> Built USER_LANDED event', eventData);
      events.push(eventData);
    } else {
      for (let i = 0; i < walletsList.length; i++) {
        const walletResult = walletsList[i];
        let chainState = (await getChainState(walletResult)) ?? {};
        const deviceState = getDeviceState(walletResult);
        let referrer = null;
        if (document.referrer) {
          pfLog('PF >>> Referrer: ', document.referrer);
          referrer = document.referrer;
        }
        let eventData = {
          tracker: {
            eventTracker: eventTracker,
            userId: userId,
            sessionId: sessionId,
            origin: location.hostname,
            referrer: referrer,
            path: urlParts.path,
            query: urlParts.query,
            ...utmParams,
          },
          device: deviceState,
          ...chainState,
        };
        pfLog('PF >>> Built USER_LANDED event', eventData);
        events.push(eventData);
      }
    }
  
    for (let i = 0; i < events.length; i++) {
      if (checkShouldLogEvent(events[i])) {
        pfLog('PF >>> Notifying gql server...');
        const response = await gqlClient.request(CreateUserLandedEvent, {
          event: events[i],
        });
        pfLog('PF >>> Server notified. Response: ', response);
        setUserId(response.createUserLandedEvent.tracker.userId);
      }
    }
  } catch(err) {
    pfLog('PF >>> USER_LANDED err', err);
  }
}

async function logWalletConnect(walletResult: WalletResponse) {
  try {
    pfLog(
      'PF >>> Logging WALLET_CONNECT event for wallet response',
      walletResult
    );
    const eventTracker: EventTracker = 'WALLET_CONNECT';
    const userId = getUserId();
    pfLog('PF >>> userId', userId);
    const sessionId = getSessionId();
    pfLog('PF >>> sessionId', sessionId);
    const utmParams = getUtmParams();
    pfLog('PF >>> utmParams', utmParams);
    const chainState = await getChainState(walletResult);
    pfLog('PF >>> chainState', chainState);
    const deviceState = getDeviceState(walletResult);
    pfLog('PF >>> deviceState', deviceState);
    const urlParts = splitPathAndQuery(location.pathname);
    let referrer = null;
    if (document.referrer) {
      pfLog('PF >>> Referrer: ', document.referrer);
      referrer = document.referrer;
    }
    let eventData = {
      tracker: {
        eventTracker: eventTracker,
        userId: userId,
        sessionId: sessionId,
        origin: location.hostname,
        referrer: referrer,
        path: urlParts.path,
        query: urlParts.query,
        ...utmParams,
      },
      device: deviceState,
      ...chainState,
    };
  
    pfLog('PF >>> Built WALLET_CONNECT event', eventData);
    if (checkShouldLogEvent(eventData)) {
      pfLog('PF >>> Notifying gql server...');
      const response = await gqlClient.request(CreateWalletConnectedEvent, {
        event: eventData,
      });
      pfLog('PF >>> Server notified. Response: ', response);
      setUserId(response.createWalletConnectedEvent.tracker.userId);
    }
  } catch(err) {
    pfLog('PF >>> WALLET_CONNECT err', err);
  }
}

interface Tx {
  from: string;
  to: string;
  data: string;
  value?: string;
}
interface TxInfo {
  from: string;
  to?: string;
  value: string;
  input: string;
  nonce: string;
  gas: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  v: string;
  r: string;
  s: string;
  hash: string;
}
async function logSendTransaction(
  tx: Tx,
  txStatus: TxStatus,
  result: any,
  walletResult: WalletResponse
) {
  try {
    pfLog('PF >>> Logging TX_REQUEST event.');
    pfLog('PF >>> Tx Data: ', tx);
    pfLog('PF >>> Tx Send Result: ', result);
    const eventTracker: EventTracker = 'TX_REQUEST';
    const userId = getUserId();
    const sessionId = getSessionId();
    const utmParams = getUtmParams();
    const chainState = await getChainState(walletResult);
    const deviceState = getDeviceState(walletResult);
    let referrer = null;
    if (document.referrer) {
      pfLog('PF >>> Referrer: ', document.referrer);
      referrer = document.referrer;
    }
  
    let txHash = null;
    let maxFeePerGas = null;
    let maxPriorityFeePerGas = null;
    let nonce = null;
    let gas = null;
    let gasPrice = null;
    let v = null;
    let r = null;
    let s = null;
  
    if (result) {
      // tx hash exists
      txHash = result as string;
      const fetchedTxInfo: TxInfo = await walletResult.provider.request({
        method: 'eth_getTransactionByHash',
        params: [txHash],
      });
      maxFeePerGas = fetchedTxInfo.maxFeePerGas
        ? BigNumber.from(fetchedTxInfo.maxFeePerGas ?? "0").toString()
        : null;
      maxPriorityFeePerGas = fetchedTxInfo.maxPriorityFeePerGas
        ? BigNumber.from(fetchedTxInfo.maxFeePerGas ?? "0").toString()
        : null;
      nonce = BigNumber.from(fetchedTxInfo.nonce ?? "0").toString();
      gas = BigNumber.from(fetchedTxInfo.gas ?? "0").toString();
      gasPrice = BigNumber.from(fetchedTxInfo.gasPrice ?? "0").toString();
      v = fetchedTxInfo.v;
      r = fetchedTxInfo.r;
      s = fetchedTxInfo.s;
    }
  
    const urlParts = splitPathAndQuery(location.pathname);
    let eventData = {
      tracker: {
        eventTracker: eventTracker,
        userId: userId,
        sessionId: sessionId,
        origin: location.hostname,
        referrer: referrer,
        path: urlParts.path,
        query: urlParts.query,
        ...utmParams,
      },
      device: deviceState,
      ...chainState,
      tx: {
        from: tx.from,
        to: tx.to,
        value: BigNumber.from(tx.value ?? "0").toString(),
        input: tx.data,
        nonce: nonce,
        gas: gas,
        gasPrice: gasPrice,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: maxPriorityFeePerGas,
        v: v,
        r: r,
        s: s,
        hash: txHash,
        status: txStatus,
      },
    };
    pfLog('PF >>> Built TX_REQUEST event', eventData);
    if (checkShouldLogEvent(eventData)) {
      pfLog('PF >>> Notifying gql server...');
      const response = await gqlClient.request(CreateTxRequestEvent, {
        event: eventData,
      });
      pfLog('PF >>> Server notified. Response: ', response);
      setUserId(response.createTxRequestEvent.tracker.userId);
  
      // if pending, wait for result
      if (txStatus == TxStatus.PENDING) {
        const receipt = await waitMined(eventData, walletResult.provider);
        pfLog('PF >>> receipt: ', receipt);
        if (receipt) {
          pfLog('PF >>> Notifying gql server about transaction status update...');
          const updateResponse = await gqlClient.request(
            UpdateTxRequestEventTxStatus,
            {
              id: response.createTxRequestEvent.id,
              newStatus: receipt.status,
            }
          );
          pfLog(
            'PF >>> Server notified about transaction status update. Response: ',
            updateResponse
          );
          setUserId(updateResponse.updateTxRequestEventTxStatus.tracker.userId);
        }
      }
    }
  } catch(err) {
    pfLog('PF >>> TX_REQUEST err', err);
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

function setUserId(userId: string) {
  localStorage.setItem(PF_SDK_USER_KEY, userId);
}

function getSessionId(): string {
  let sessionId = sessionStorage.getItem(PF_SDK_SESSION_KEY);
  if (sessionId) {
    return sessionId;
  } else {
    sessionId = crypto.randomUUID();
    sessionStorage.setItem(PF_SDK_SESSION_KEY, sessionId);
    return sessionId;
  }
}

interface WCObject {
  connected: boolean;
  accounts: string[];
  chainId: number;
  bridge: string;
  key: string;
  clientId: string;
  clientMeta: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  peerId: string;
  peerMeta: {
    name: string;
    description: string;
    url: string;
    icons: string[];
  };
  handshakeId: number;
  handshakeTopic: string;
}
function fetchWcObject() {
  pfLog('PF >>> fetching wc object');
  const wc = localStorage.getItem('walletconnect');
  if (wc) {
    pfLog('PF >>> fetched wc object', wc);
    wcObject = JSON.parse(wc);
    pfLog('PF >>> parsed wc object', wcObject);
  } else {
    pfLog('PF >>> failed to fetch wc object. Wc: ', wc);
  }
}

interface CbObject {
  sessionId: string;
  sessionSecret: string;
  addresses: string;
  linked: string;
  defaultChainId: string;
  defaultJsonRpcUrl: string;
}
function fetchCbObject(newAddressesValue?: string) {
  pfLog('PF >>> fetching cb object');
  const sessionId = localStorage.getItem(
    '-walletlink:https://www.walletlink.org:session:id'
  );
  // const appVersion = localStorage.getItem("-walletlink:https://www.walletlink.org:AppVersion");
  const linked = localStorage.getItem(
    '-walletlink:https://www.walletlink.org:session:linked'
  );
  const defaultChainId = localStorage.getItem(
    '-walletlink:https://www.walletlink.org:DefaultChainId'
  );
  const defaultJsonRpcUrl = localStorage.getItem(
    '-walletlink:https://www.walletlink.org:DefaultJsonRpcUrl'
  );
  // const hasChainOverridenFromRelay = localStorage.getItem("-walletlink:https://www.walletlink.org:HasChainOverriddenFromRelay");
  const sessionSecret = localStorage.getItem(
    '-walletlink:https://www.walletlink.org:session:secret'
  );
  const addresses =
    newAddressesValue ??
    localStorage.getItem('-walletlink:https://www.walletlink.org:Addresses');
  // const walletUsername = localStorage.getItem("-walletlink:https://www.walletlink.org:walletUsername");
  // const version = localStorage.getItem("-walletlink:https://www.walletlink.org:version");
  pfLog('PF >>> cb:sessionId', sessionId);
  pfLog('PF >>> cb:linked', linked);
  pfLog('PF >>> cb:defaultChainId', defaultChainId);
  pfLog('PF >>> cb:defaultJsonRpcUrl', defaultJsonRpcUrl);
  pfLog('PF >>> cb:sessionSecret', sessionSecret);
  pfLog('PF >>> cb:addresses', addresses);

  if (
    sessionId &&
    linked &&
    linked === '1' &&
    addresses &&
    addresses.length > 0 &&
    sessionSecret &&
    defaultChainId &&
    defaultJsonRpcUrl
  ) {
    cbObject = {
      sessionId,
      sessionSecret,
      linked,
      addresses,
      defaultChainId,
      defaultJsonRpcUrl,
    };
    pfLog('PF >>> parsed cb object', cbObject);
  } else {
    pfLog('PF >>> failed to fetch cb object. Cb: ', {
      sessionId: sessionId,
      linked: linked,
      sessionSecret: sessionSecret,
      addresses: addresses,
    });
  }
}

interface WalletResponse {
  type: ProviderType;
  provider: any;
  wallet: string;
  walletProvider: string;
}
async function fetchWallet(): Promise<WalletResponse[]> {
  const providerResult = await getProvider();

  const result: WalletResponse[] = [];
  for (let i = 0; i < providerResult.length; i++) {
    const p = providerResult[i];
    if (p.type === 'walletconnect') {
      if (!wcObject) continue;
      result.push({
        type: p.type,
        wallet: wcObject.accounts[0].toLowerCase(),
        walletProvider: wcObject.peerMeta.name.toLowerCase(),
        provider: p.provider,
      });
    } else if (p.type === 'coinbase') {
      if (!cbObject) continue;
      result.push({
        type: p.type,
        wallet: cbObject.addresses.toLowerCase(),
        walletProvider: p.type,
        provider: p.provider,
      });
    } else {
      let accounts = [];
      if (p.provider.hasOwnProperty('accounts')) {
        // if .accounts array already exists on provider (case for frame.sh wallet)
        accounts = p.provider.accounts;
      } else {
        // if no .accounts exist, try to fetch from provider
        accounts = await p.provider.request({ method: 'eth_accounts' });
      }
      let wallet = '';
      if (accounts && accounts.length > 0) {
        wallet = accounts[0];
      }
      result.push({
        type: p.type,
        wallet: wallet.toLowerCase(),
        walletProvider: getProviderNameForMetamask(),
        provider: p.provider,
      });
    }
  }
  return result;
}

interface ChainState {
  wallet: {
    walletAddress: string;
    gasBalance: string;
    nonce: string;
    networkId: number;
  };
  network: {
    chainId: number;
    blockHeight: string;
    gasPrice: string;
  };
}
async function getChainState(
  walletResult: WalletResponse
): Promise<ChainState | null> {
  const provider = walletResult.provider;
  if (!walletResult.wallet) {
    return null;
  }

  const getBalanceResponse = await provider.request({
    method: 'eth_getBalance',
    params: [walletResult.wallet, 'latest'],
  });
  pfLog('PF >>> getBalanceResponse', getBalanceResponse);
  const gasBalance = BigNumber.from(getBalanceResponse ?? "0").toString();

  const nonceResponse = await provider.request({
    method: 'eth_getTransactionCount',
    params: [walletResult.wallet, 'latest'],
  });
  pfLog('PF >>> nonceResponse', nonceResponse);
  const nonce = BigNumber.from(nonceResponse ?? "0").toString();

  const networkIdResponse = await provider.request({ method: 'eth_chainId' });
  pfLog('PF >>> chainIdResponse', networkIdResponse);
  const networkId = BigNumber.from(networkIdResponse ?? "0").toNumber();

  const blockHeightResponse = await provider.request({
    method: 'eth_blockNumber',
  });
  pfLog('PF >>> blockHeightResponse', blockHeightResponse);
  const blockHeight = BigNumber.from(blockHeightResponse ?? "0").toString();

  const gasPriceResponse = await provider.request({ method: 'eth_gasPrice' });
  pfLog('PF >>> gasPriceResponse', gasPriceResponse);
  const gasPrice = BigNumber.from(gasPriceResponse ?? "0").toString();

  const chainState = {
    wallet: {
      walletAddress: walletResult.wallet,
      gasBalance: gasBalance,
      nonce: nonce,
      networkId: networkId,
    },
    network: {
      chainId: networkId,
      gasPrice: gasPrice,
      blockHeight: blockHeight,
    },
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
  pfLog('PF >>> Storing UTM params');
  const urlSearchParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(urlSearchParams.entries());
  const paramsObject = {
    utmSource: params.utm_source,
    utmMedium: params.utm_medium,
    utmCampaign: params.utm_campaign,
    utmContent: params.utm_content,
    utmTerm: params.utm_term,
  };
  const paramsObjectStringified = JSON.stringify(paramsObject);
  sessionStorage.setItem(PF_SDK_UTM_KEY, paramsObjectStringified);
}

function getUtmParams(): UtmParams {
  const paramsObject = JSON.parse(
    sessionStorage.getItem(PF_SDK_UTM_KEY) ?? '{}'
  );
  return paramsObject;
}

interface ScreenState {
  w: number;
  h: number;
}

interface DeviceState {
  os?: string;
  browser?: string;
  country?: string;
  screen?: ScreenState;
  walletProvider: string;
  walletType: string;
}

function getDeviceState(walletResult: WalletResponse | null): DeviceState {
  const userAgent = window.navigator.userAgent;
  const parsedUserAgent = uaParser(userAgent);

  let userCountry = 'unknown';
  if (Intl) {
    const tzArr = Intl.DateTimeFormat().resolvedOptions().timeZone.split('/');
    const userCity: string = tzArr[tzArr.length - 1];
    userCountry = (timeZoneCityToCountry as any)[userCity] ?? 'unknown';
  }

  return {
    os: parsedUserAgent.os.name,
    browser: parsedUserAgent.browser.name,
    country: userCountry,
    screen: {
      w: screen.width,
      h: screen.height,
    },
    walletType: walletResult?.type ?? 'none',
    walletProvider: walletResult?.walletProvider ?? 'none',
  };
}

type ProviderName =
  | 'metamask'
  | 'trust'
  | 'gowallet'
  | 'alphawallet'
  | 'status'
  | 'coinbase'
  | 'cipher'
  | 'mist'
  | 'parity'
  | 'infura'
  | 'localhost'
  | 'walletconnect'
  | 'rabby'
  | 'frame'
  | 'unknown';

function getProviderNameForMetamask(): ProviderName {
  const fetchedProvider = (window as any).ethereum;
  if (fetchedProvider.isTrust) return 'trust';
  if (fetchedProvider.isGoWallet) return 'gowallet';
  if (fetchedProvider.isAlphaWallet) return 'alphawallet';
  if (fetchedProvider.isStatus) return 'status';
  if (fetchedProvider.isCoinbaseWallet) return 'coinbase';
  if (fetchedProvider.isRabby) return 'rabby';
  if (fetchedProvider.isFrame) return 'frame';
  if (typeof (window as any).__CIPHER__ !== 'undefined') return 'cipher';
  if (fetchedProvider.constructor.name === 'EthereumProvider') return 'mist';
  if (fetchedProvider.constructor.name === 'Web3FrameProvider') return 'parity';
  if (fetchedProvider.host && fetchedProvider.host.indexOf('infura') !== -1)
    return 'infura';
  if (fetchedProvider.host && fetchedProvider.host.indexOf('localhost') !== -1)
    return 'localhost';
  if (fetchedProvider.isMetaMask) return 'metamask';
  return 'unknown';
}

type ProviderType = 'injected' | 'walletconnect' | 'coinbase'; // add more providers (dev3 widget, magic link, web3auth, ...)

interface ProviderResult {
  type: ProviderType;
  provider: any;
}
async function getProvider(): Promise<ProviderResult[]> {
  pfLog('PF >>> getProvider() call');

  const providers: ProviderResult[] = [];
  if (wcObject) {
    pfLog('PF >>> Detected walletconnect provider...');
    providers.push({
      type: 'walletconnect',
      provider: await chainIdToWeb3Provider(wcObject.chainId),
    });
  }

  if (cbObject) {
    pfLog('PF >>> Detected coinbase provider...');
    providers.push({
      type: 'coinbase',
      provider: new Web3HttpProvider(cbObject.defaultJsonRpcUrl),
    });
  }

  if ((window as any).ethereum) {
    pfLog('PF >>> Detected window.ethereum provider...');
    providers.push({
      type: 'injected',
      provider: (window as any).ethereum,
    });
  } else if ((window as any).web3 && (window as any).web3.currentProvider) {
    pfLog('PF >>> Detected window.web3.currentProvider provider...');
    providers.push({
      type: 'injected',
      provider: (window as any).web3.currentProvider,
    });
  } else {
    pfLog('PF >>> Missing provider!');
  }

  return providers;
}

async function chainIdToWeb3Provider(chainId: number): Promise<any> {
  pfLog('PF >>> wc object to web3 provider');
  const rpc = chainlist.get(chainId.toString());
  if (!rpc) {
    pfLog('PF >>> Missing rpc!');
    return null;
  }
  pfLog('PF >>> Rpc: ', rpc);
  const provider = new Web3HttpProvider(rpc);
  return provider;
}

enum TxStatus {
  PENDING = 'PENDING',
  SUCCESS = 'SUCCESS',
  FAILURE = 'FAILURE',
  CANCELLED = 'CANCELLED',
}
interface TxReceipt {
  blockNumber: string;
  status?: TxStatus;
}
async function waitMined(
  eventData: any,
  provider: any,
  retries: number = 50,
  pollIntervalSeconds: number = 5
): Promise<TxReceipt | null> {
  const txHash = eventData.tx.hash;
  pfLog(`PF >>> Waiting tx minded for hash ${txHash}`);
  let attempts = 0;
  while (attempts < retries) {
    pfLog(`PF >>> Attempt ${attempts} to fetch the receipt...`);
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [txHash],
    });
    pfLog(`PF >>> Receipt fetched: `, receipt);
    if (receipt && receipt.blockNumber) {
      const status = receipt.status;
      pfLog(
        `PF >>> Transaction included in block ${receipt.blockNumber}. Transaction status is ${status}!`
      );
      return {
        blockNumber: receipt.blockNumber,
        status: status === '0x0' ? TxStatus.FAILURE : TxStatus.SUCCESS,
      };
    }
    await sleep(pollIntervalSeconds * 1000);
    attempts++;
  }
  pfLog(`PF >>> Waiting for transaction timed out...`);
  return null;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PathAndQuery {
  path?: string;
  query?: string;
}
function splitPathAndQuery(text?: string): PathAndQuery {
  const splitted = (text ?? '').split('?');
  if (splitted.length === 0) {
    return {};
  } else if (splitted.length === 1) {
    return { path: splitted[0] };
  } else {
    return { path: splitted[0], query: splitted[1] };
  }
}

function checkShouldLogEvent(event: any): boolean {
  const eventHash = hashEvent(event);
  pfLog('PF >>> Check should log event, for event hash: ', eventHash);
  const hashMap = loadMap();
  const currentTimestamp = Date.now();
  const previousTimestamp = hashMap.get(eventHash);

  let shouldBeLogged = true;
  if (previousTimestamp) {
    const timeDifference = currentTimestamp - previousTimestamp;
    pfLog(
      'PF >>> Previous timestamp found. Time difference (in ms): ',
      timeDifference
    );
    if (timeDifference < MIN_TIME_DIFF_FOR_EVENT_LOG_MS) {
      pfLog(
        `PF >>> Time difference < ${MIN_TIME_DIFF_FOR_EVENT_LOG_MS}ms. Event should be logged: false`
      );
      shouldBeLogged = false;
    }
  }

  storeEvent(eventHash, currentTimestamp);
  return shouldBeLogged;
}

function storeEvent(eventHash: string, timestamp: number) {
  const hashMap = loadMap();
  hashMap.set(eventHash, timestamp);
  storeMap(hashMap);
}

function loadMap(): Map<string, number> {
  const storedHashMapString = localStorage.getItem(PF_EVENTS_HASH_MAP);
  const storedHashMap = JSON.parse(storedHashMapString ?? '[]');
  const hashMap = new Map<string, number>(storedHashMap);
  return hashMap;
}

function storeMap(hashMap: Map<string, number>) {
  localStorage.setItem(PF_EVENTS_HASH_MAP, JSON.stringify([...hashMap]));
}

function hashEvent(event: any) {
  const data = JSON.stringify(event);
  let hash = 0;
  for (let i = 0, len = data.length; i < len; i++) {
    let chr = data.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash.toString();
}

function pfLog(...args: any[]) {
  if (LOG_ENABLED) {
    console.log(...args);
  }
}
