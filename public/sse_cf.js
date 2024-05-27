// sse_cf_demo.js
//
// 2023-12-01 Moonbase59
// 2023-12-02 Moonbase59 - retry forever on errors, workaround for Chrome bug
//                       - add player autostart
//                       - add album art alt text, link title
// 2023-12-04 Moonbase59 - add localStorage cache for better UX
// 2023-12-05 Moonbase59 - code cleanup, add translatable strings
//                       - use event listener instead of .onreadystatechange
//                       - encapsulate in function so we don't pollute globals
//                       - multiple instances of this script now possible
//                       - autoplay now switchable (per instance of this script)
// 2023-12-07 Moonbase59 - changed to work with new HPNP API
// 2023-12-08 Moonbase59 - code optimization; example with live AzuraCast Demo Station
//                       - immediate Offline indication in case of EventSource failures
// 2023-12-13 Moonbase59 - change addClasses/removeClasses to spred syntax
//                       - show station offline in show name
//                       - revert HPNP to Centrifugo
// 2023-12-14 Moonbase59 - Update for new version that sends initial NP data on connect
// 2024-01-26 Moonbase59 - Add short/long timezone names and global time from server
//                       - Add elapsed/duration song data per station for progress bars.
// 2024-01-27 Moonbase59 - Add station time and time offset data (to help users with Schedule)
//                       - Fix negative minutes in sub-hour GMT offsets (would show "-6:-30")
//                       - Refactored "np-global-..." to "np-local-...". That's what it is.
//                       - Refactor progress bars, based on an idea by gAlleb (Stefan):
//                         Now initially gets elapsed & duration on song change only,
//                         and refreshes automatically every second via a "setInterval".
//                         Added logic to kill these if the station suddenly goes offline.
// 2024-01-28 Moonbase59 - Make elapsed seconds float, increases accuracy, allows different
//                         setInterval() times.
// 2024-01-29 Moonbase59 - Implement timezone from API (Azuracast RR 6b511b0 (2024-01-29)),
//                         with fallback for older versions. Assume station is on UTC if
//                         timezone can't be determined.
//                       - Fix bug with negative UTC offsets (returned an hour too much)
//                       - Show "0" in np-xxx-station-timediff-minutes element.
// 2024-01-31 Moonbase59 - Add np-xxx-song-duration, np-xxx-song-elapsed.
//                       - Add np-xxx-song-progressbar which updates the width % on an
//                         element like a simple <div> progress bar.
// 2024-02-01 Moonbase59 - minSec(): Avoid times like "3:60" for 239.51 seconds being
//                         returned in np-xxx-song-elapsed and progress bar title,
//                         use Math.trunc() instead of Math.round()
//                       - Ensure np-xxx-song-progressbar width <= 100%, 100% on live.
//                       - Don’t let elapsed overrun duration, except on live (duration=0),
//                         a wish from Stefan (@gAlleb).
//                       - Update progress with every SSE update instead of every song,
//                         to re-sync "jumping" API elapsed values in case of jingles.
//                       - Force initial update on startProgressBar (don’t wait 1 second)
// 2024-02-02 Moonbase59 - Add missing "last_update" in startProgressBar.
//                       - Add station description as title attribute to np-xxx-station-name
// 2024-02-05 Moonbase59 - Add station listener counts.
//
// AzuraCast Now Playing SSE event listener for one or more stations
// Will update elements with class names structured like
//   np-stationshortcode-item-subitem
// Example:
//   <img class="np-niteradio-song-albumart" title="Artist - Title" src="" width=150 />
//   will be updated with the album cover of the current song on station 'niteradio'
// Usage:
//   Save this JS somewhere in your web space and put something like this
//   at the end of your HTML body:
//   <script src="sse_cf_demo.js"></script>

// wrap in a function so we don’t overlap globals with other instances
(function () {
  // hard-coded video player location for now, API doesn’t yet provide
  const video_player_url = "";

  // station base URL
  const baseUri = "https://flus.fm";
  // station shortcode(s) you wish to subscribe to
  // use the real shortcodes here; class names will automatically be "kebab-cased",
  // i.e. "azuratest_radio" → "azuratest-radio"
  // AzuraCast Rolling Release 6b511b0 (2024-01-29) and newer provide tz data in the API.
  // If you are on an older version, specify station timezone like this:
  //   "station:azuratest_radio": {timezone: "Etc/UTC"},
  let subs = {
    "station:flus.fm": { timezone: "Etc/UTC" },
    //"station:other-station": {},
    //"station:third-station": {},
    "global:time": {}, // server timestamp
  };
  // allow autoplay (same domain only)?
  const autoplay = false;

  // set common SSE URL
  const sseUri =
    baseUri +
    "/api/live/nowplaying/sse?cf_connect=" +
    JSON.stringify({
      subs: subs,
    });

  // init subscribers
  Object.keys(subs).forEach((station) => {
    subs[station]["nowplaying"] = null;
    subs[station]["last_sh_id"] = null;
    subs[station]["elapsed"] = 0;
    subs[station]["duration"] = 0;
    subs[station]["last_update"] = Date.now(); // time in ms of last progress bar update
    subs[station]["interval_id"] = 0; // holds nonzero updateProgressBar interval ID
  });

  // store "global:time" timestamp updates here
  let serverTime = 0;

  // Translatable strings
  // Style the online, live, and request indicators using classes
  // 'label', 'label-success' (green) and 'label-error' (red) in your CSS.
  const t = {
    "Album art. Click to listen.": "Album art. Click to listen.", // album art alt text
    "Click to listen": "Click to listen", // player link title (tooltip)
    "Click to view": "Click to view", // video player link title (tooltip)
    Live: "Live", // live indicator text
    "Live: ": "", // prefix to streamer name on live shows
    Offline: "Offline", // offline indicator text
    Online: "Online", // online indicator text
    "Song request": "Song request", // request indicator text
  };
  // As an example, here are the German translations:
  //const t = {
  //"Album art. Click to listen.": "Albumcover. Klick zum Zuhören.", // album art alt text
  //"Click to listen": "Klick zum Zuhören", // player link title (tooltip)
  //"Click to view": "Klick zum Zusehen", // video player link title (tooltip)
  //"Live": "Live", // live indicator text
  //"Live: ": "Live: ",  // prefix to streamer name on live shows
  //"Offline": "Offline", // offline indicator text
  //"Online": "Online", // online indicator text
  //"Song request": "Musikwunsch" // request indicator text
  //};

  // return short or long timezone name in user's locale
  // type can be "short" or "long"
  function getTimezoneName(type) {
    const today = new Date();
    const short = today.toLocaleDateString(undefined);
    const full = today.toLocaleDateString(undefined, { timeZoneName: type });
    // Trying to remove date from the string in a locale-agnostic way
    const shortIndex = full.indexOf(short);
    if (shortIndex >= 0) {
      const trimmed =
        full.substring(0, shortIndex) +
        full.substring(shortIndex + short.length);
      // by this time `trimmed` should be the timezone's name with some punctuation -
      // trim it from both sides
      return trimmed.replace(/^[\s,.\-:;]+|[\s,.\-:;]+$/g, "");
    } else {
      // in some magic case when short representation of date is not present in the long one, just return the long one as a fallback, since it should contain the timezone's name
      return full;
    }
  }

  // return hh:mm string from timestamp (used for show start/end times)
  function getTimeFromTimestamp(timestamp) {
    // convert a UNIX timestamp (seconds since epoch)
    // to JS time (milliseconds since epoch)
    let tmp = new Date(timestamp * 1000);
    return (
      tmp.getHours().toString().padStart(2, "0") +
      ":" +
      tmp.getMinutes().toString().padStart(2, "0")
    );
  }

  // return MM:SS from seconds
  function minSec(duration) {
    const minutes = Math.trunc(duration / 60);
    // Need to use Math.trunc instead of Math.round,
    // to avoid results like "3:60" being returned on times like 239.51 seconds
    const seconds = Math.trunc(duration % 60);
    return `${String(minutes)}:${String(seconds).padStart(2, "0")}`;
  }

  // return station time data and offset to user’s local time
  function getStationTime(station) {
    // AzuraCast Rolling Release 6b511b0 (2024-01-29) and newer provide tz data in the API
    let tz = subs[station]?.nowplaying?.station?.timezone || undefined;
    // timezone fallback: API → subs[station].timezone → "Etc/UTC"
    tz = tz || subs[station]?.timezone || "Etc/UTC";
    const now = new Date();
    // tz == undefined will result in zero difference
    const nowStation = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const diffMinutes = Math.round((nowStation - now) / 60000);
    const hours = Math.trunc(diffMinutes / 60);
    const minutes = Math.abs(diffMinutes % 60);
    const stationTime = getTimeFromTimestamp(nowStation.getTime() / 1000);
    const stationOffset = `${Intl.NumberFormat("en-US", {
      signDisplay: "exceptZero",
    }).format(hours)}:${String(minutes).padStart(2, "0")}`;
    //console.log(now, nowStation, tz, diffMinutes, hours, minutes);
    return {
      time: stationTime,
      timezone: tz,
      timediffHHMM: stationOffset,
      timediffMinutes: diffMinutes,
    };
  }

  // Sanitize a station shortcode, so it can be used in a CSS class name
  const toKebabCase = (str) =>
    str &&
    str
      .match(
        /[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g
      )
      .map((x) => x.toLowerCase())
      .join("-");

  function setElement(
    target,
    content,
    {
      addClasses = null,
      attrib = null,
      style = null,
      removeClasses = null,
      timeconvert = false,
    } = {}
  ) {
    // set elements with class="target" to content & modify/set attributes
    // we use classes instead of ids because elements can occur multiple times
    // will safely ignore any elements that are not used in the page
    // (i.e. you don't have to have containers for all ids)
    // content = "" or undefined means: set to empty
    // content = null means: don’t touch content, just modify attribs
    // this is used for user-named indicators ("is..." and "station-player")
    let targets = Array.from(document.getElementsByClassName(target));

    targets.forEach((targ) => {
      if (targ && content) {
        // this target id is used on the page, load it
        // normal node with content, i.e. <tag>content</tag>
        if (timeconvert) {
          targ.textContent = getTimeFromTimestamp(content);
        } else {
          targ.textContent = content;
        }
      } else if (targ && content !== null) {
        // null = don’t modify (user can set in page)
        // empty or undefined = set to empty
        targ.textContent = "";
      }
      // set attributes, if any
      if (targ && attrib) {
        Object.entries(attrib).forEach(([k, v]) => {
          targ.setAttribute(k, v);
        });
      }
      // set styles, if any
      if (targ && style) {
        Object.entries(style).forEach(([k, v]) => {
          targ.style[k] = v;
        });
      }
      // remove Classes, if any
      if (targ && removeClasses) {
        targ.classList.remove(...removeClasses);
      }
      // add Classes, if any
      if (targ && addClasses) {
        targ.classList.add(...addClasses);
      }
    });
  }

  function startProgressBar(station, elapsed, duration) {
    subs[station]["elapsed"] = elapsed;
    subs[station]["duration"] = duration;
    // start fresh point in time to later calculate "elapsed" from
    subs[station]["last_update"] = Date.now();
    if (subs[station]["interval_id"] == 0) {
      // start new updater interval if not already running: 1 update/second
      subs[station]["interval_id"] = setInterval(
        updateProgressBar,
        1000,
        station
      );
    }
    // do an initial update, don’t want to wait a second
    updateProgressBar(station);
  }

  function stopProgressBar(station) {
    if (subs[station]["interval_id"] !== 0) {
      clearInterval(subs[station]["interval_id"]);
    }
    subs[station]["interval_id"] = 0;
  }

  function updateProgressBar(station) {
    // CF subs look like "station:shortcode", remove "station:"
    let ch = station.split(":")[1] || null;
    // sanitize station shortcode for use in a CSS class name
    ch = toKebabCase(ch);
    // increment elapsed time every second
    // This is NOT 1s each round, since the updating alse takes time,
    // which would lead to increasing in accuracy on longer songs
    // if we just added 1s each time round.
    let now = Date.now(); // a millisecond timestamp
    // allow elapsed (seconds) to be float (more exact)
    subs[station]["elapsed"] += (now - subs[station]["last_update"]) / 1000;
    subs[station]["last_update"] = now;
    // Don’t let elapsed overrun duration, except on live (duration=0 in this case)
    if (
      subs[station]["duration"] > 0 &&
      subs[station]["elapsed"] > subs[station]["duration"]
    ) {
      subs[station]["elapsed"] = subs[station]["duration"];
      stopProgressBar(station);
    }
    // update <progress> progress bar element on page
    setElement("np-" + ch + "-song-progress", null, {
      attrib: {
        value: subs[station]["elapsed"],
        max: subs[station]["duration"],
        title: minSec(subs[station]["elapsed"]),
      },
    });
    // update simple <div> progressbars using width %; div/zero gets us "Infinity"
    let width = (subs[station]["elapsed"] / subs[station]["duration"]) * 100.0;
    width = width > 100 ? 100 : width;
    setElement("np-" + ch + "-song-progressbar", null, {
      style: {
        width: String(width) + "%",
      },
    });
    // update np-xxx-song-elapsed text display element; np-xxx-song-duration stays unchanged
    setElement("np-" + ch + "-song-elapsed", minSec(subs[station]["elapsed"]));

    //console.log("updateProgressBar:", station,
    //  subs[station]["elapsed"], "/", subs[station]["duration"]);
  }

  function updatePage(station) {
    // update elements on the page (per station)
    // CF subs look like "station:shortcode", remove "station:"
    let ch = station.split(":")[1] || null;
    // sanitize station shortcode for use in a CSS class name
    ch = toKebabCase(ch);
    const np = subs[station]?.nowplaying || null;
    //console.log(np.now_playing.sh_id, subs[station]["last_sh_id"]);
    // Update time every time
    if (np) {
      let stationTime = getStationTime(station);
      setElement("np-" + ch + "-station-time", stationTime["time"]);
      setElement("np-" + ch + "-station-timezone", stationTime["timezone"]);
      setElement(
        "np-" + ch + "-station-timediff-hhmm",
        stationTime["timediffHHMM"]
      );
      setElement(
        "np-" + ch + "-station-timediff-minutes",
        String(stationTime["timediffMinutes"])
      );
      //console.log(stationTime);
      setElement("np-local-time", getTimeFromTimestamp(Date.now() / 1000));
      setElement("np-local-timezone-short", getTimezoneName("short"));
      setElement("np-local-timezone-long", getTimezoneName("long"));
      setElement(
        "np-" + ch + "-song-duration",
        "/ " + minSec(np.now_playing.duration)
      );
      // start self-updating song progress bar; also sets np-xxx-song-elapsed
      startProgressBar(
        station,
        np.now_playing.elapsed,
        np.now_playing.duration
      );
      //setElement("np-" + ch + "-song-elapsed", minSec(np.now_playing.elapsed));
      // station listener counts
      setElement(
        "np-" + ch + "-station-listeners-total",
        String(np.listeners.total)
      );
      setElement(
        "np-" + ch + "-station-listeners-unique",
        String(np.listeners.unique)
      );
      setElement(
        "np-" + ch + "-station-listeners-current",
        String(np.listeners.current)
      );
    }
    // Only update page elements when Song Hash ID changes
    if (np && np.now_playing.sh_id !== subs[station]["last_sh_id"]) {
      // Handle Now Playing data update as `np` variable.
      console.log(
        "Now Playing on " +
          ch +
          (np.is_online ? " (online)" : " (offline)") +
          ": " +
          np.now_playing.song.text
      );
      subs[station]["last_sh_id"] = np.now_playing.sh_id;
      //setElement("np-" + ch + "-sh-id", np.now_playing.sh_id);
      setElement("np-" + ch + "-song-artist", np.now_playing.song.artist);
      setElement("np-" + ch + "-song-title", np.now_playing.song.title);
      setElement("np-" + ch + "-song-text", np.now_playing.song.text); // artist - title
      setElement("np-" + ch + "-song-album", np.now_playing.song.album);
      setElement("np-" + ch + "-song-albumart", "", {
        attrib: {
          alt: t["Album art. Click to listen."],
          src: np.now_playing.song.art,
          //"title": np.now_playing.song.text
        },
      });
      setElement("np-" + ch + "-station-name", np.station.name, {
        attrib: {
          title: np.station.description,
        },
      });
      setElement("np-" + ch + "-station-description", np.station.description);
      setElement("np-" + ch + "-station-url", np.station.url);
      setElement(
        "np-" + ch + "-station-player-url",
        np.station.public_player_url
      );
      setElement("np-" + ch + "-station-player", null, {
        attrib: {
          href:
            np.station.public_player_url + (autoplay ? "?autoplay=true" : ""),
          target: "playerWindow",
          title: t["Click to listen"],
        },
      });
      // hard-coded for now
      if (video_player_url) {
        setElement("np-" + ch + "-video-player-url", video_player_url);
        setElement("np-" + ch + "-video-player", null, {
          attrib: {
            href: video_player_url,
            target: "playerWindow",
            title: t["Click to view"],
          },
        });
      } else {
        setElement("np-" + ch + "-video-player-url", "");
        setElement("np-" + ch + "-video-player", "");
      }

      if (np.is_online) {
        setElement("np-" + ch + "-station-isonline", t["Online"], {
          addClasses: ["label-success"],
          attrib: { style: "display: inline;" },
          removeClasses: ["label-error"],
        });
      } else {
        setElement("np-" + ch + "-station-isonline", t["Offline"], {
          addClasses: ["label-error"],
          attrib: { style: "display: inline;" },
          removeClasses: ["label-success"],
        });
        // stop self-updating progress bar if one is running
        stopProgressBar(station);
      }

      if (np.live.is_live) {
        // live streamer, set indicator & show name
        setElement(
          "np-" + ch + "-song-duration",
          "/ " + minSec(np.now_playing.duration),
          { attrib: { style: "display: none;" } }
        );
        setElement("np-" + ch + "-show-islive", t["Live"], {
          attrib: { style: "display: inline;" },
          addClasses: ["label", "label-error"],
        });
        setElement(
          "np-" + ch + "-show-name",
          t["Live: "] + np.live.streamer_name,
          {
            removeClasses: ["label", "label-error"],
          }
        );
      } else {
        // not live, hide indicator
        setElement("np-" + ch + "-show-islive", t["Live"], {
          attrib: { style: "display: none;" },
        });
        if (np.is_online) {
          // not live && online: show name = playlist name
          setElement("np-" + ch + "-show-name", np.now_playing.playlist, {
            removeClasses: ["label", "label-error"],
          });
          setElement(
            "np-" + ch + "-song-duration",
            "/ " + minSec(np.now_playing.duration),
            { attrib: { style: "display: inline;" } }
          );
        } else {
          // not live && offline: show name = Offline indicator
          setElement("np-" + ch + "-show-name", t["Offline"], {
            addClasses: ["label", "label-error"],
          });
          // stop self-updating progress bar if one is running
          stopProgressBar(station);
        }
      }

      if (np.now_playing.is_request) {
        setElement("np-" + ch + "-song-isrequest", t["Song request"], {
          attrib: { style: "display: inline;" },
        });
      } else {
        setElement("np-" + ch + "-song-isrequest", t["Song request"], {
          attrib: { style: "display: none;" },
        });
      }
    }
  }

  function showOffline() {
    // If EventSource failed, we might never get an offline message,
    // so we update our status and the web page to let the user know immediately.
    Object.keys(subs).forEach((station) => {
      if (subs[station]["nowplaying"] && subs[station]["last_sh_id"] !== null) {
        // only do this once – errors might repeat every few seconds
        console.warn("Now Playing: Setting", station, "offline");
        subs[station]["nowplaying"]["is_online"] = false;
        // reset last song hash id to force updatePage()
        subs[station]["last_sh_id"] = null;
        updatePage(station); // should also handle stopping progress bars
        // reset last song hash id again since overwritten by updatePage
        // This guarantees a fresh update on a later reconnect.
        subs[station]["last_sh_id"] = null;
      }
    });
  }

  let evtSource = null;

  function initEvents() {
    // currently, we have to set up one connection per station
    if (evtSource === null || evtSource.readyState === 2) {
      evtSource = new EventSource(sseUri);

      evtSource.onerror = (err) => {
        console.error("Now Playing: EventSource failed:", err);
        // We might not have gotten an "offline" event, so better
        // force "Station Offline" and user will know something is wrong
        showOffline();
        // no special restart handler anymore -- will retry forever if not closed
        // this works around the dreaded Chrome net::ERR_NETWORK_CHANGED error
        // Note that on SEVERE errors like server unreachable, no network, etc.
        // the EventSource will give up and we deliberately NOT try a reconnection
        // (might overload already overloaded servereven more).
        // Let the user press F5 to refresh page in this case.
      };

      evtSource.onopen = function () {
        console.log("Now Playing: Server connected.");
      };

      function handleData(payload) {
        // handle data for server time or a single station
        const jsonData = payload?.pub?.data ?? {};
        if (payload.channel === "global:time") {
          // This is a "time" ping to let you know what the current time
          // is on the server, so you can properly display elapsed/remaining time
          // for your tracks. It's in the form of a UNIX timestamp.
          // Occurs roughly every minute.
          serverTime = jsonData.time;
        } else {
          // This is a now-playing event from a station.
          // Update your now-playing data accordingly.
          const station = "station:" + jsonData.np?.station?.shortcode || null;
          if (station in subs) {
            subs[station]["nowplaying"] = jsonData.np;
            updatePage(station);
          }
        }
      }

      evtSource.onmessage = (event) => {
        const jsonData = JSON.parse(event.data);
        if ("connect" in jsonData) {
          // Initial data is sent in the "connect" response as an array
          // of rows similar to individual messages.
          const initialData = jsonData.connect.data ?? [];
          initialData.forEach((initialRow) => handleData(initialRow));
        } else if ("channel" in jsonData) {
          handleData(jsonData);
        }
      };
    }
  }

  // wait until DOM ready then start listening to SSE events
  document.addEventListener("readystatechange", (event) => {
    if (event.target.readyState === "complete") {
      // Document complete. Must use 'complete' instead of 'interactive',
      // otherwise onlick handlers in many CMS’es don't work correctly.
      // start listening to SSE events
      initEvents();
    }
  });

  // end wrapper
})();
