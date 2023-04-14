# Polyflow SDK

[Polyflow](www.polyflow.dev) is an analytics tool used to gain useful insight, monitor activity and track incidents on the web3 applications - in real time! The SDK is used to connect your web3 application to the dashbaord in minutes.

Polyflow features:
- easy to set up (~10 minutes)
- works out of the box
- tracks events such as: user landed, wallet connected, transaction executed...
- profiles the users based on the location, browser, wallet provider, device type, wallet activity...
- reports errors and incidents in real time. You don't have to wait for someone to report an issue.

## 📊 Usage

To start using the tool and monitor your application in real-time, follow the two steps outlined below.

### Step 1
First make sure to go to the [Polyflow Dashboard](https://polyflow-console.vercel.app/) and setup an account.
Once you sign up and create a project, you'll need to obtain an API key. This key will be used to connect the SDK to the Dashboard and start logging events!

Here's where the API key will be shown once you register and create your project on the dashboard:

![API key location on the Polyflow Dashboard](/images/api-key.png "API key location on the Polyflow Dashboard")

### Step 2
Add this SDK to your frontend project by installing the package:
```shell
$ npm install @polyflow/sdk
```

Then import the library and add a single line of code somewhere in your frontend's initialization phase:

```javascript
import { attach } from "@polyflow/sdk";

// somewhere in the frontend initialization block
attach("YOUR API KEY"); // provide your API key from the dashboard

// you're done! Start monitoring events on the polyflow dashboard right away!
```

## 🛠 Local build

Make sure you update your environment to NodeJS v16 before running the steps below.

To build the project, first clone the repo and then run:

```shell
$ npm install
 
$ npm run build
```

To use the local build, run the
```shell
$ npm package
```
which is going to generate local npm package.

## 👋🏻 Reach out

You can provide feedback or request an enterprise whitelabel integration by reaching out to us at:

***<p style="text-align: center;">hello@polyflow.dev</p>***
