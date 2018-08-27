"use strict";

const ts = require('./tinyspeck.js'), datastore = require("./datastore.js").async;

var slack = ts.instance({});
var connected=false;

String.prototype.hashCode = function() {
  var hash = 0, i, chr;
  if (this.length === 0) return hash;
  for (i = 0; i < this.length; i++) {
    chr   = this.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

slack.on('/gurui', payload => {
  let user_id = payload.user_id;
  let response_url = payload.response_url;  
  let text = payload.text;
  console.log("/gurui called. Processing payload:");
  console.log(JSON.stringify(payload));
  
  if (text === "" || text === "help") {
    var helpText = `
/gurui
  - help
    - show this text

  - mint [n] token(s) to [@user]
    - add n of your own tokens to @user's purse
  - spend [n] [@user] token(s)
    - removes n @user tokens from your purse

  - purse
    - show all coins in your purse
  - debts
    - show all of your debts

  - council
    - show the five richest users
  - pets
    - show all users who are in more debt than they have tokens
    `;
    slackSend(response_url, { response_type: "in_channel", attachments: [{ text: helpText }] });
  } else if (text == "buff arnold") {
    var buffArnoldUrl = "https://i.pinimg.com/originals/0d/52/33/0d52339908d5aeb3b8bb082c2ddbfd38.gif";
    slackSend(response_url, { response_type: "in_channel", attachments: [{ fallback: "buff arnold", image_url: buffArnoldUrl }] });
  } else {
    // TODO: parse command before establashing connection would be nice.
    getConnected().then(function(){
      var statekey = "loca-state";
      // we store tokens in a god object under key "state"
      datastore.get(statekey).then(function(state){
        console.log("state: " + JSON.stringify(state));
        state = state || {};

        let [newState, response] = processCommand(user_id, state, text);
        console.log("newState: " + JSON.stringify(newState));

        datastore.set(statekey, newState).then(function() {
          if (Array.isArray(response)) {
            response.forEach((r, i) => {
              // We stagger the sending of the responses by 100 millis so they show up in the correct order (hopefully).
              setTimeout(() => slackSend(response_url, r), i*100)
            });
          } else {
            slackSend(response_url, response);
          }
        }); // TODO on error here
      });
    });  
  }
});

function processCommand(user, state, text) {
  let newState = state; // newState is a lie, I'm altering state directly!
  let response = { response_type: "in_channel", text: "Sorry I didn't catch that. Try `/gurui help`." };

  function sortNetWorths(a,b) {
    if (a[1] > b[1]) return -1;
    if (a[1] < b[1]) return 1;

    if (a[0].hashCode() > b[0].hashCode()) return 1;
    if (a[0].hashCode() < b[0].hashCode()) return -1;
  }
  
  if(text === "council") {
    var netWorths = calculateNetWorths(state);
    var council = Object.entries(netWorths)
      .filter(n => n[1] > 0)
      .sort((a, b) => sortNetWorths(a,b))
      .slice(0, 5);
    
    if (council.length == 0) {
      response = { response_type: "in_channel", text: "The council is empty." };
    } else {
      var councilPositions = ["President", "Vice President", "Treasurer", "Secretary", "Head of Public Relations"];
      var councilString = `The council:\n`;
      council.forEach((c, i) => {
        councilString += `${councilPositions[i]} - <@${c[0]}> (net worth: ${c[1]})\n`;
      });
      
      response = { response_type: "in_channel", text: councilString };
    }
  }
    
  if(text === "pets") {
      var netWorths = calculateNetWorths(state);
      var pets = Object.entries(netWorths)
        .filter(n => n[1] < 0)
        .sort((a, b) => sortNetWorths(b,a))

    if (pets.length == 0) {
      response = { response_type: "in_channel", text: "There are no pets." };
    } else {
      var petsString = `Pets:\n`;
      pets.forEach(p => { petsString += `<@${p[0]}> (net worth: ${p[1]}) \n`; });
      response = { response_type: "in_channel", text: petsString };
    }
  }
  
  if(text === "purse") {
    let purse = state[user];
    if(!purse) {
      console.log("no purse found");
      response = { response_type: "in_channel", text: "Your purse is empty!" };
    } else {
      var originalPurseString = `<@${user}>'s purse:\n`;
      var purseString = originalPurseString;
      Object.entries(purse).forEach(entry => {
        var k = entry[0];
        var v = entry[1];
        if (v != 0) {
          purseString += `• ${v} <@${k}> token${v == 1 ? "" : "s"}\n`;
        }
      });
      
      if (purseString === originalPurseString) { // no entries were added
        response = { response_type: "in_channel", text: "Your purse is empty!" };
      } else {
        response = { response_type: "in_channel", text: purseString };
      }
    }
  }
  
  if(text === "debts") {
    let debts = [];
    for (var key in state) {
      if (state.hasOwnProperty(key)) {
        var purse = state[key];
        if(purse[user] && purse[user] > 0) {
          debts.push({ owed_to: key, value: purse[user] });
        }
      }
    }
    
    if (debts.length === 0) {
      response = { response_type: "in_channel", text: "You are debt free!" };
    } else {
      var debtsString = `<@${user}>'s outstanding debts:\n`;
      debts.forEach((d) => {
        debtsString += `• ${d.value} token${d.value == 1 ? "" : "s"} to <@${d.owed_to}>\n`
      });
      response = { response_type: "in_channel", text: debtsString };
    }
  }
                                
  let mintRegex = /^mint (\d+ )?tokens? to <@([^>|]*?)(?:\|[^>|]*?)?>$/
  var m = text.match(mintRegex);
  if(m) {
    var n = parseInt(m[1] || "1");
    var to = m[2];
    if (user === to) {
      response = { response_type: "in_channel", text: "You can't mint tokens to yourself." };
    } else {
      state[to] = state[to] || {};
      state[to][user] = state[to][user] || 0;
      state[to][user] += n;
      response = { response_type: "in_channel", text: `<@${user}> minted ${n} token${n == 1 ? "" : "s"} to <@${to}>` };
      
      // Let's also show debts afterwords HACK ALERT:
      // Don't do this for anything that changes state!
      let [xxx, debtsResponse] = processCommand(user, state, "debts");
      response = [response, debtsResponse];
    }
  }
  
  let spendRegex = /^spend (\d+ )?<@([^>|]*?)(?:\|[^>|]*?)?> tokens?$/
  var m = text.match(spendRegex);
  if (m) {
    var n = parseInt(m[1] || "1");
    var spendType = m[2];
    if(user === spendType) {
      response = { response_type: "in_channel", text: "You can't spend your own tokens." };
    } else {
      state[user] = state[user] || {};
      var tokensOfSpendType = state[user][spendType];
      if(!tokensOfSpendType) {
        response = { response_type: "in_channel", text: `Tokens not spent. You don't have any <@${spendType}> tokens!` };
      } else if (tokensOfSpendType < n) {
        response = { response_type: "in_channel", text: `Tokens not spent. You only have ${tokensOfSpendType} <@${spendType}> tokens!` };
      } else {
        state[user][spendType] -= n;
        response = { response_type: "in_channel", text: `Successfully spent ${n} <@${spendType}> token${n == 1 ? "" : "s"}!` };
        
        // Let's also show purse afterwords HACK ALERT:
        // Don't do this for anything that changes state!
        let [xxx, purseResponse] = processCommand(user, state, "purse");
        response = [response, purseResponse];
      }
    }
  }
  
  
  return [newState, response];
}

function calculateNetWorths(state) {
  var netWorths = {};
  
  // for each purse
  for (var key in state) {
    if (state.hasOwnProperty(key)) {
      console.log(key);
      var purse = state[key];
      console.log(purse);
      // for each token in purse
      for (var token in purse) {
        if (purse.hasOwnProperty(token)) {
          // owner of purse
          netWorths[key] = netWorths[key] || 0;
          netWorths[key] += purse[token];
          
          // token type
          netWorths[token] = netWorths[token] || 0;
          netWorths[token] -= purse[token];
        }
      }
    }
  }
  
  return netWorths;
}

function getConnected() {
  return new Promise(function (resolving) {
    if(!connected){
      connected = datastore.connect().then(function(){
        resolving();
      });
    } else {
      resolving();
    }
  });
}

function slackSend(response_url, response) {
  slack.send(response_url, response).then(res => { // on success
    // all set
  }, reason => { // on failure
    console.log("An error occurred when responding to /gurui slash command: " + reason);
  });
}
    
// incoming http requests
slack.listen('3000');