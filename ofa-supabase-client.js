(function (window) {
  function readConfig() {
    return window.OFA_SUPABASE || {};
  }

  function isConfigured() {
    var config = readConfig();
    return !!(config.url && config.anonKey);
  }

  function getStorageKey() {
    var config = readConfig();
    return config.sessionStorageKey || "ofa_remote_session";
  }

  function getStorageBucket() {
    var config = readConfig();
    return config.storageBucket || "";
  }

  function getStoragePathPrefix() {
    var config = readConfig();
    return config.storagePathPrefix || "auction-images";
  }

  function getSupabaseClient() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") {
      throw new Error("SUPABASE_LIBRARY_MISSING");
    }
    if (!isConfigured()) {
      throw new Error("SUPABASE_CONFIG_MISSING");
    }
    if (!getSupabaseClient._client) {
      var config = readConfig();
      getSupabaseClient._client = window.supabase.createClient(config.url, config.anonKey, {
        auth: { persistSession: false }
      });
    }
    return getSupabaseClient._client;
  }

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(getStorageKey()) || "null");
    } catch (error) {
      return null;
    }
  }

  function writeSession(session) {
    if (session) {
      localStorage.setItem(getStorageKey(), JSON.stringify(session));
      return;
    }
    localStorage.removeItem(getStorageKey());
  }

  async function rpc(fn, params) {
    var client = getSupabaseClient();
    var result = await client.rpc(fn, params || {});
    if (result.error) {
      throw result.error;
    }
    return result.data;
  }

  function sessionToken() {
    var session = readSession();
    return session && session.token ? session.token : "";
  }

  function requireToken() {
    var token = sessionToken();
    if (!token) {
      throw new Error("AUTH_REQUIRED");
    }
    return token;
  }

  function normalizeSession(payload) {
    if (!payload || !payload.token) {
      return null;
    }
    return {
      token: payload.token,
      role: payload.role,
      accountId: payload.account_id || payload.accountId || "",
      accountName: payload.account_name || payload.accountName || "",
      loginId: payload.login_id || payload.loginId || ""
    };
  }

  function normalizeLots(rows) {
    return Array.isArray(rows) ? rows : [];
  }

  function normalizeDealers(rows) {
    return Array.isArray(rows) ? rows : [];
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl || "").split(",");
    if (parts.length < 2) {
      throw new Error("INVALID_IMAGE_DATA");
    }
    var mimeMatch = parts[0].match(/data:(.*?);base64/);
    var mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
    var binary = atob(parts[1]);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  function buildStoragePath() {
    return [
      getStoragePathPrefix(),
      new Date().toISOString().slice(0, 10),
      Date.now() + "-" + Math.floor(Math.random() * 100000) + ".jpg"
    ].join("/");
  }

  var api = {
    isConfigured: isConfigured,
    configSummary: function () {
      var config = readConfig();
      return {
        hasUrl: !!config.url,
        hasAnonKey: !!config.anonKey,
        hasStorageBucket: !!config.storageBucket
      };
    },
    storageSummary: function () {
      return {
        bucket: getStorageBucket(),
        pathPrefix: getStoragePathPrefix()
      };
    },
    canUploadToStorage: function () {
      return isConfigured() && !!getStorageBucket();
    },
    readSession: readSession,
    clearSession: function () {
      writeSession(null);
    },
    adminStatus: function () {
      return rpc("ofa_admin_status");
    },
    validateSession: async function () {
      var token = sessionToken();
      if (!token) {
        return null;
      }
      try {
        var payload = await rpc("ofa_validate_session", { p_token: token });
        var session = normalizeSession(payload);
        writeSession(session);
        return session;
      } catch (error) {
        writeSession(null);
        return null;
      }
    },
    logout: async function () {
      var token = sessionToken();
      if (token) {
        try {
          await rpc("ofa_logout", { p_token: token });
        } catch (error) {
          // Ignore logout cleanup errors and clear local state anyway.
        }
      }
      writeSession(null);
    },
    bootstrapAdmin: async function (password) {
      var payload = await rpc("ofa_admin_bootstrap", { p_password: password });
      var session = normalizeSession(payload);
      writeSession(session);
      return session;
    },
    adminLogin: async function (password) {
      var payload = await rpc("ofa_admin_login", { p_password: password });
      var session = normalizeSession(payload);
      writeSession(session);
      return session;
    },
    changeAdminPassword: function (newPassword) {
      return rpc("ofa_admin_change_password", {
        p_token: requireToken(),
        p_new_password: newPassword
      });
    },
    dealerLogin: async function (loginId, password) {
      var payload = await rpc("ofa_dealer_login", {
        p_login_id: loginId,
        p_password: password
      });
      var session = normalizeSession(payload);
      writeSession(session);
      return session;
    },
    listDealers: async function () {
      var rows = await rpc("ofa_list_dealers", { p_token: requireToken() });
      return normalizeDealers(rows);
    },
    upsertDealer: async function (payload) {
      return rpc("ofa_upsert_dealer", {
        p_token: requireToken(),
        p_payload: payload
      });
    },
    deleteDealer: async function (dealerId) {
      return rpc("ofa_delete_dealer", {
        p_token: requireToken(),
        p_dealer_id: dealerId
      });
    },
    uploadImageDataUrl: async function (dataUrl) {
      if (!getStorageBucket()) {
        throw new Error("STORAGE_BUCKET_MISSING");
      }
      var client = getSupabaseClient();
      var path = buildStoragePath();
      var blob = dataUrlToBlob(dataUrl);
      var uploadResult = await client.storage.from(getStorageBucket()).upload(path, blob, {
        contentType: blob.type || "image/jpeg",
        upsert: false
      });
      if (uploadResult.error) {
        throw uploadResult.error;
      }
      var publicResult = client.storage.from(getStorageBucket()).getPublicUrl(path);
      if (!publicResult || !publicResult.data || !publicResult.data.publicUrl) {
        throw new Error("STORAGE_PUBLIC_URL_FAILED");
      }
      return {
        path: path,
        publicUrl: publicResult.data.publicUrl
      };
    },
    listLots: async function () {
      var rows = await rpc("ofa_list_lots");
      return normalizeLots(rows);
    },
    getLotDetail: function (lotId) {
      return rpc("ofa_get_lot_detail", {
        p_token: requireToken(),
        p_lot_id: lotId
      });
    },
    upsertLot: function (payload) {
      return rpc("ofa_upsert_lot", {
        p_token: requireToken(),
        p_payload: payload
      });
    },
    deleteLot: function (lotId) {
      return rpc("ofa_delete_lot", {
        p_token: requireToken(),
        p_lot_id: lotId
      });
    },
    setLotSold: function (lotId, sold) {
      return rpc("ofa_set_lot_sold", {
        p_token: requireToken(),
        p_lot_id: lotId,
        p_sold: !!sold
      });
    },
    createBid: function (lotId, payload) {
      return rpc("ofa_create_bid", {
        p_token: requireToken(),
        p_lot_id: lotId,
        p_payload: payload
      });
    },
    revealBid: function (bidId, password) {
      return rpc("ofa_reveal_bid", {
        p_token: requireToken(),
        p_bid_id: bidId,
        p_password: password
      });
    }
  };

  window.OFA_API = api;
})(window);
