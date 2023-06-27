function hexStringToUint8Array(hexString: string): Uint8Array {
  return new Uint8Array(
    hexString.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
  );
}

/**
 *
 * @param cipherText hex string representation of bytes in the order: initialization vector (iv),
 * auth tag, encrypted plaintext. IV is 12 bytes. Auth tag is 16 bytes.
 * @param secret hex string representation of 32-byte secret
 */
export function aes256gcmDecrypt(
  cipherText: string,
  secret: string
): Promise<string> {
  if (secret.length !== 64) throw Error(`secret must be 256 bits`);
  return new Promise<string>((resolve, reject) => {
    void (async function () {
      const secretKey: CryptoKey = await crypto.subtle.importKey(
        'raw',
        hexStringToUint8Array(secret),
        { name: 'aes-gcm' },
        false,
        ['encrypt', 'decrypt']
      );

      const encrypted: Uint8Array = hexStringToUint8Array(cipherText);

      const ivBytes = encrypted.slice(0, 12);
      const authTagBytes = encrypted.slice(12, 28);
      const encryptedPlaintextBytes = encrypted.slice(28);
      const concattedBytes = new Uint8Array([
        ...encryptedPlaintextBytes,
        ...authTagBytes,
      ]);
      const algo = {
        name: 'AES-GCM',
        iv: new Uint8Array(ivBytes),
      };
      try {
        const decrypted = await window.crypto.subtle.decrypt(
          algo,
          secretKey,
          concattedBytes
        );
        const decoder = new TextDecoder();
        resolve(decoder.decode(decrypted));
      } catch (err) {
        reject(err);
      }
    })();
  });
}
