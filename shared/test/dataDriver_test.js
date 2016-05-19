/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

describe("loop.DataDriver", () => {
  "use strict";

  let { expect } = chai;
  let { actions } = loop.shared;
  let { CHAT_CONTENT_TYPES } = loop.shared.utils;

  let clock, fakeXHR, requests, sandbox;
  let dispatcher, driver;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    sandbox = LoopMochaUtils.createSandbox();

    dispatcher = new loop.Dispatcher();
    sandbox.stub(dispatcher, "dispatch");

    driver = new loop.DataDriver({
      dispatcher
    });

    fakeXHR = sandbox.useFakeXMLHttpRequest();
    requests = [];
    fakeXHR.xhr.onCreate = function(xhr) {
      requests.push(xhr);
    };
    sandbox.stub(window, "EventSource", url => {
      requests.push({ url });
      return {
        addEventListener() {},
        removeEventListener() {}
      };
    });
  });

  afterEach(() => {
    clock.restore();
    sandbox.restore();
    LoopMochaUtils.restore();
  });

  // Helper to get the room and resource of a url.
  function getRoomResource(url) {
    return url.match(/[^\/]+\/[^\/]+$/)[0];
  }

  // Helper to get just the resource of a url.
  function getResource(url) {
    return getRoomResource(url).split("/")[1];
  }

  describe("Constructor", () => {
    it("should throw an error if the dispatcher is missing", () => {
      expect(() => new loop.DataDriver({})).to.Throw(/dispatcher/);
    });
  });

  describe("#sendTextChatMessage", () => {
    it("should send a message by updating a chat record", () => {
      driver.sendTextChatMessage({
        contentType: CHAT_CONTENT_TYPES.TEXT,
        message: "Are you there?"
      });

      let { method, requestBody, url } = requests[0];
      expect(method).eql("PUT");
      expect(requestBody).eql('{"timestamp":{".sv":"timestamp"},"value":{"contentType":"chat-text","message":"Are you there?"}}');
      expect(url.match(/([^\/]+).{12}\.json$/)[1]).eql("chat!00000000");
    });
  });

  describe("#fetchServerData", () => {
    it("should connect to the room on server data", () => {
      driver.fetchServerData(new actions.FetchServerData({
        token: "fakeFetch",
        windowType: "room"
      }));

      expect(getRoomResource(requests[0].url)).eql("fakeFetch/.json?limitToLast=1&orderBy=%22timestamp%22");
      expect(getRoomResource(requests[1].url)).eql("fakeFetch/meta!lastConnect.json");
    });
  });

  describe("#setupWindowData", () => {
    it("should connect to the room on window data", () => {
      driver.setupWindowData(new actions.SetupWindowData({
        roomToken: "fakeSetup"
      }));

      expect(getRoomResource(requests[0].url)).eql("fakeSetup/.json?limitToLast=1&orderBy=%22timestamp%22");
      expect(getRoomResource(requests[1].url)).eql("fakeSetup/meta!lastConnect.json");
    });
  });

  describe("#handleEvent.open", () => {
    it("should dispatch `DataChannelsAvailable` when the connection is opened", () => {
      driver.handleEvent({ type: "open" });

      sinon.assert.called(dispatcher.dispatch);
      sinon.assert.calledWithExactly(dispatcher.dispatch,
        new actions.DataChannelsAvailable({ available: true }));
    });
  });

  describe("#handleEvent.put", () => {
    it("should skip initial load put /", () => {
      driver.handleEvent({
        data: JSON.stringify({
          data: {
            "chat!01234567abcdefghijkl": {
              timestamp: 1234567890123,
              value: {
                contentType: CHAT_CONTENT_TYPES.TEXT,
                message: "Are you there?",
                sentTimestamp: "2016-05-10T18:26:58.235Z"
              }
            }
          },
          path: "/"
        }),
        type: "put"
      });

      sinon.assert.notCalled(dispatcher.dispatch);
    });

    it("should dispatch `ReceivedTextChatMessage` when a text message is received", () => {
      driver.handleEvent({
        data: JSON.stringify({
          data: {
            timestamp: 1234567890123,
            value: {
              contentType: CHAT_CONTENT_TYPES.TEXT,
              message: "Are you there?",
              sentTimestamp: "2016-05-10T18:26:58.235Z"
            }
          },
          path: "/chat!01234567abcdefghijkl"
        }),
        type: "put"
      });

      sinon.assert.called(dispatcher.dispatch);
      sinon.assert.calledWithExactly(dispatcher.dispatch,
        new actions.ReceivedTextChatMessage({
          contentType: CHAT_CONTENT_TYPES.TEXT,
          message: "Are you there?",
          receivedTimestamp: "2009-02-13T23:31:30.123Z",
          sentTimestamp: "2016-05-10T18:26:58.235Z"
        }));
    });
  });

  describe("#handleEvent.error", () => {
    it("should retry the connection on error", () => {
        // This calls _connectToRoom, so don't stub it out until after.
        driver.setupWindowData(new actions.SetupWindowData({
          roomToken: "fakeSetup"
        }));
        sandbox.stub(driver, "_connectToRoom");
        driver.handleEvent({ type: "error" });
        clock.tick(driver.INITIAL_RETRY_TIMEOUT + 1);
        sinon.assert.called(driver._connectToRoom);
    });

    it("should exponentially back off while retrying", () => {
        driver.setupWindowData(new actions.SetupWindowData({
          roomToken: "fakeSetup"
        }));
        driver.handleEvent({ type: "error" });
        clock.tick(driver.INITIAL_RETRY_TIMEOUT + 1);
        expect(driver._retryTimeout).eql(driver.INITIAL_RETRY_TIMEOUT * 2);
        driver.handleEvent({ type: "error" });
        clock.tick(driver.INITIAL_RETRY_TIMEOUT * 2 + 1);
        expect(driver._retryTimeout).eql(driver.INITIAL_RETRY_TIMEOUT * 4);
        driver.handleEvent({ type: "error" });
        clock.tick(driver.INITIAL_RETRY_TIMEOUT * 4 + 1);
        expect(driver._retryTimeout).eql(driver.INITIAL_RETRY_TIMEOUT * 8);
    });
  });

  describe("#getServerTime", () => {
    it("should default to now", () => {
      // Default fake time starts at 0.
      expect(driver.getServerTime()).eql(0);
    });

    it("should be later now", () => {
      clock.tick(1234);
      expect(driver.getServerTime()).eql(1234);
    });

    it("should default to skewed now", () => {
      driver._clockSkew = 1;
      expect(driver.getServerTime()).eql(1);
    });

    it("should offset with positive skew", () => {
      driver._clockSkew = 1234;
      expect(driver.getServerTime(11111)).eql(12345);
    });

    it("should offset with negative skew", () => {
      driver._clockSkew = -1234;
      expect(driver.getServerTime(5555)).eql(4321);
    });
  });

  describe("#makeId", () => {
    it("should default to now", () => {
      let id1 = driver.makeId();
      let id2 = driver.makeId(Date.now());

      expect(id1.slice(0, 8)).eql(id2.slice(0, 8));
    });

    it("should make different ids for same time", () => {
      let now = Date.now();
      let id1 = driver.makeId(now);
      let id2 = driver.makeId(now);

      expect(id1).not.eql(id2);
      expect(id1.slice(0, 8)).eql(id2.slice(0, 8));
    });

    it("should make the same leading id for specific times", () => {
      expect(driver.makeId(0).slice(0, 8)).eql("00000000");
      expect(driver.makeId(1).slice(0, 8)).eql("00000001");
      expect(driver.makeId(1234567890).slice(0, 8)).eql("0019aWBI");
    });
  });

  describe("#requestChat", () => {
    it("should have defaults", () => {
      driver.requestChat();
      let idNow = driver.makeId(Date.now() + 1).slice(0, 8);

      let queries = requests[0].url.split("?")[1].split("&").sort();
      expect(queries).contain("orderBy=%22%24key%22");
      expect(queries).contain(`limitToLast=${driver.MAX_LIMIT}`);
      expect(queries[3].match(/^.+chat!.{8}/)[0]).eql("startAt=%22chat!00000000");
      expect(queries[0].match(/^.+chat!.{8}/)[0]).eql(`endAt=%22chat!${idNow}`);
    });

    it("should support inclusive time ranges", () => {
      driver.requestChat(2, 8);

      let queries = requests[0].url.split("?")[1].split("&").sort();
      expect(queries[3].match(/^.+chat!.{8}/)[0]).eql("startAt=%22chat!00000001");
      expect(queries[0].match(/^.+chat!.{8}/)[0]).eql("endAt=%22chat!00000009");
    });

    it("should support limits", () => {
      driver.requestChat(0, 1, 2);

      let queries = requests[0].url.split("?")[1].split("&").sort();
      expect(queries).contain("limitToLast=2");
    });
  });

  describe("#update", () => {
    beforeEach(() => {
      driver.update("theType", "theId", "theValue");
    });

    it("should make a PUT request", () => {
      expect(requests[0].method).eql("PUT");
    });

    it("should request to a combined key", () => {
      expect(getResource(requests[0].url)).eql("theType!theId.json");
    });

    it("should send the value", () => {
      expect(JSON.parse(requests[0].requestBody).value).eql("theValue");
    });

    it("should additionally send timestamp special value", () => {
      expect(JSON.parse(requests[0].requestBody).timestamp).eql({ ".sv": "timestamp" });
    });
  });

  describe("#_buildQuery", () => {
    it("should make a single key=value", () => {
      let query = driver._buildQuery({ key: "value" });
      expect(query).eql("key=value");
    });

    it("should handle multiple pairs", () => {
      let query = driver._buildQuery({
        k1: "v1",
        k2: "v2"
      });
      expect(query).eql("k1=v1&k2=v2");
    });

    it("should encode keys and values", () => {
      let query = driver._buildQuery({ "key?": "the value" });
      expect(query).eql("key%3F=the%20value");
    });
  });

  describe("#_buildUrl", () => {
    it("should have defaults", () => {
      driver._roomToken = "defaultRoom";
      let url = driver._buildUrl();
      expect(getRoomResource(url)).eql("defaultRoom/.json");
    });

    it("should take a resource", () => {
      driver._roomToken = "defaultRoom";
      let url = driver._buildUrl("theResource");
      expect(getRoomResource(url)).eql("defaultRoom/theResource.json");
    });

    it("should take a resource and room", () => {
      let url = driver._buildUrl("theResource", "theRoom");
      expect(getRoomResource(url)).eql("theRoom/theResource.json");
    });

    it("should encode room and resource", () => {
      let url = driver._buildUrl("res?", "the room");
      expect(getRoomResource(url)).eql("the%20room/res%3F.json");
    });
  });

  describe("#_connectToRoom", () => {
    it("should try to connect to the room", () => {
      driver._connectToRoom("theRoom");

      expect(getRoomResource(requests[0].url)).eql("theRoom/.json?limitToLast=1&orderBy=%22timestamp%22");
      expect(getRoomResource(requests[1].url)).eql("theRoom/meta!lastConnect.json");
    });

    it("should remember the room token", () => {
      driver._connectToRoom("theRoom");

      expect(driver._roomToken).eql("theRoom");
    });

    it("should set positive clock skew", () => {
      driver._connectToRoom("theRoom");
      requests[1].respond(200, {}, '{"timestamp":1234}');

      // Server time is 1234 and local time is 0.
      expect(driver._clockSkew).eql(1234);
    });

    it("should set negative clock skew", () => {
      clock.tick(5555);
      driver._connectToRoom("theRoom");
      requests[1].respond(200, {}, '{"timestamp":1234}');

      // Server time is 1234 and local time is 5555.
      expect(driver._clockSkew).eql(-4321);
    });

    it("should request last 24 hours of chat after updating lastConnect", () => {
      sandbox.stub(driver, "requestChat", () => Promise.resolve({}));

      let oneOverDay = 24 * 60 * 60 * 1000 + 1;
      driver._connectToRoom("theRoom");
      requests[1].respond(200, {}, `{"timestamp":${oneOverDay}}`);

      sinon.assert.called(driver.requestChat);
      sinon.assert.calledWithExactly(driver.requestChat, 1, oneOverDay, 25);
    });
  });

  describe("#_processRecord.chat", () => {
    it("should dispatch `ReceivedTextChatMessage` for chat record", () => {
      driver._processRecord("chat!01234567abcdefghijkl", {
        timestamp: 1234567890123,
        value: {
          contentType: CHAT_CONTENT_TYPES.TEXT,
          message: "Are you there?",
          sentTimestamp: "2016-05-10T18:26:58.235Z"
        }
      });

      sinon.assert.called(dispatcher.dispatch);
      sinon.assert.calledWithExactly(dispatcher.dispatch,
        new actions.ReceivedTextChatMessage({
          contentType: CHAT_CONTENT_TYPES.TEXT,
          message: "Are you there?",
          receivedTimestamp: "2009-02-13T23:31:30.123Z",
          sentTimestamp: "2016-05-10T18:26:58.235Z"
        }));
    });
  });

  describe("#_processRecords", () => {
    it("should dispatch `ReceivedTextChatMessage` for one chat of multiple records", () => {
      driver._processRecords({
        "chat!01234567abcdefghijkl": {
          timestamp: 1234567890123,
          value: {
            contentType: CHAT_CONTENT_TYPES.TEXT,
            message: "Are you there?",
            sentTimestamp: "2016-05-10T18:26:58.235Z"
          }
        },
        "meta!lastConnect": {
          timestamp: 2345678901234
        }
      });

      sinon.assert.called(dispatcher.dispatch);
      sinon.assert.calledWithExactly(dispatcher.dispatch,
        new actions.ReceivedTextChatMessage({
          contentType: CHAT_CONTENT_TYPES.TEXT,
          message: "Are you there?",
          receivedTimestamp: "2009-02-13T23:31:30.123Z",
          sentTimestamp: "2016-05-10T18:26:58.235Z"
        }));
    });
  });

  describe("#_request", () => {
    it("should make a GET request", () => {
      driver._request("GET", "http://dummy/url");

      let { method, requestBody, url } = requests[0];
      expect(method).eql("GET");
      expect(requestBody).eql(null);
      expect(url).eql("http://dummy/url");
    });

    it("should make a GET request with query", () => {
      driver._request("GET", "http://dummy/url", "theQuery");

      let { method, requestBody, url } = requests[0];
      expect(method).eql("GET");
      expect(requestBody).eql(null);
      expect(url).eql("http://dummy/url?theQuery");
    });

    it("should make a PUT request with body", () => {
      driver._request("PUT", "http://dummy/url", { the: "body" });

      let { method, requestBody, url } = requests[0];
      expect(method).eql("PUT");
      expect(requestBody).eql('{"the":"body"}');
      expect(url).eql("http://dummy/url");
    });

    it("should resolve on success", done => {
      driver._request("GET", "http://dummy/url").then(response => {
        expect(response).eql({ the: "response" });
        done();
      });

      requests[0].respond(200, {}, '{"the":"response"}');
    });

    it("should reject on failure", () => {
      driver._request("GET", "http://dummy/url");

      try {
        // Promise become SyncThenable that throws instead of reject.
        requests[0].respond(400, {}, "failed");
        sinon.assert.fail("should have thrown");
      } catch (ex) {
        expect(ex).has.property("name", "REQUEST_ERROR");
        expect(ex).has.deep.property("request.responseText", "failed");
      }
    });
  });
});