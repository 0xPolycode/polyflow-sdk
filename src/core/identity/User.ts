import { JwtToken } from '../types';

export class User {
  public readonly wallet: string;
  public readonly jwt: JwtToken;

  constructor(wallet: string, jwt: JwtToken) {
    this.wallet = wallet;
    this.jwt = jwt;
  }
}
