-- LuaForge Studio Plugin v3 — Auto Console Capture + Version History
-- What's new:
--   • Auto-streams Studio console errors to server (no manual paste)
--   • Shows error notification badge in the plugin panel
--   • Version history panel — browse and restore past scripts
--   • Error count badge on the toolbar button

local HttpService   = game:GetService("HttpService")
local RunService    = game:GetService("RunService")
local StudioService = game:GetService("StudioService")
local ScriptEditorService = game:GetService("ScriptEditorService")

-- ─── CONFIG ──────────────────────────────────────────────────────────────────
local SERVER_URL = "https://luaforge-production-b226.up.railway.app"
local WS_URL     = "wss://luaforge-production-b226.up.railway.app"

-- ─── Plugin storage ───────────────────────────────────────────────────────────
local STORAGE_KEY_TOKEN    = "luaforge_auth_token"
local STORAGE_KEY_USERNAME = "luaforge_username"

local plugin = plugin

local function saveToken(token, username)
	plugin:SetSetting(STORAGE_KEY_TOKEN,    token)
	plugin:SetSetting(STORAGE_KEY_USERNAME, username)
end
local function loadToken()
	return plugin:GetSetting(STORAGE_KEY_TOKEN), plugin:GetSetting(STORAGE_KEY_USERNAME)
end
local function clearToken()
	plugin:SetSetting(STORAGE_KEY_TOKEN,    nil)
	plugin:SetSetting(STORAGE_KEY_USERNAME, nil)
end

-- ─── HTTP helpers ─────────────────────────────────────────────────────────────
local function post(path, body, token)
	local headers = { ["Content-Type"] = "application/json" }
	if token then headers["Authorization"] = "Bearer " .. token end
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url    = SERVER_URL .. path,
			Method = "POST",
			Headers = headers,
			Body   = HttpService:JSONEncode(body),
		})
	end)
	if not ok then error("Network error: " .. tostring(res)) end
	local data = HttpService:JSONDecode(res.Body)
	if not res.Success then error(data.error or ("HTTP " .. res.StatusCode)) end
	return data
end

local function httpGet(path, token)
	local headers = {}
	if token then headers["Authorization"] = "Bearer " .. token end
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url     = SERVER_URL .. path,
			Method  = "GET",
			Headers = headers,
		})
	end)
	if not ok then return nil end
	if not res.Success then return nil end
	local ok2, data = pcall(function() return HttpService:JSONDecode(res.Body) end)
	return ok2 and data or nil
end

local function getMe(token)
	return httpGet("/api/auth/me", token)
end

-- ─── Colors & Fonts ───────────────────────────────────────────────────────────
local STATUS_OK   = Color3.fromRGB(16, 185, 129)
local STATUS_ERR  = Color3.fromRGB(248, 113, 113)
local STATUS_WARN = Color3.fromRGB(251, 191, 36)
local BG          = Color3.fromRGB(11,  13,  17)
local SURFACE     = Color3.fromRGB(19,  22,  29)
local BORDER      = Color3.fromRGB(37,  42,  56)
local ACCENT      = Color3.fromRGB(0,   229, 255)
local TEXT        = Color3.fromRGB(232, 234, 240)
local MUTED       = Color3.fromRGB(90,  96,  112)
local FONT_MAIN   = Enum.Font.GothamBold
local FONT_MONO   = Enum.Font.Code

local function makeLabel(parent, text, size, pos, color, fontSize)
	local lbl = Instance.new("TextLabel")
	lbl.Text = text
	lbl.Size = size or UDim2.new(1, 0, 0, 20)
	lbl.Position = pos or UDim2.new(0, 0, 0, 0)
	lbl.BackgroundTransparency = 1
	lbl.TextColor3 = color or TEXT
	lbl.Font = FONT_MAIN
	lbl.TextSize = fontSize or 13
	lbl.TextXAlignment = Enum.TextXAlignment.Left
	lbl.Parent = parent
	return lbl
end

local function makeInput(parent, placeholder, pos, isPassword)
	local box = Instance.new("TextBox")
	box.PlaceholderText = placeholder
	box.PlaceholderColor3 = MUTED
	box.Size = UDim2.new(1, 0, 0, 34)
	box.Position = pos or UDim2.new(0, 0, 0, 0)
	box.BackgroundColor3 = BG
	box.BorderSizePixel = 0
	box.TextColor3 = TEXT
	box.Font = FONT_MONO
	box.TextSize = 13
	box.ClearTextOnFocus = false
	box.TextXAlignment = Enum.TextXAlignment.Left
	if isPassword then box.TextTransparency = 1; box.Text = "" end
	box.Parent = parent
	local corner = Instance.new("UICorner"); corner.CornerRadius = UDim.new(0, 6); corner.Parent = box
	local pad = Instance.new("UIPadding"); pad.PaddingLeft = UDim.new(0, 10); pad.Parent = box
	if isPassword then
		local realText = ""
		local updating = false
		box:GetPropertyChangedSignal("Text"):Connect(function()
			if updating then return end
			updating = true
			local raw = box.Text
			if #raw > #realText then realText = realText .. raw:sub(#realText + 1)
			elseif #raw < #realText then realText = realText:sub(1, #raw) end
			box.Text = string.rep("•", #realText)
			box:SetAttribute("realText", realText)
			updating = false
		end)
		box._getRealText = function() return realText end
	end
	return box
end

local function makeButton(parent, text, pos, size, accent)
	local btn = Instance.new("TextButton")
	btn.Text = text
	btn.Size = size or UDim2.new(1, 0, 0, 36)
	btn.Position = pos or UDim2.new(0, 0, 0, 0)
	btn.BackgroundColor3 = accent and ACCENT or SURFACE
	btn.BorderSizePixel = 0
	btn.TextColor3 = accent and BG or TEXT
	btn.Font = FONT_MAIN
	btn.TextSize = 13
	btn.AutoButtonColor = true
	btn.Parent = parent
	local corner = Instance.new("UICorner"); corner.CornerRadius = UDim.new(0, 8); corner.Parent = btn
	return btn
end

-- ─── Plugin toolbar ───────────────────────────────────────────────────────────
local toolbar   = plugin:CreateToolbar("LuaForge")
local mainBtn   = toolbar:CreateButton("LuaForge", "Open LuaForge AI Panel", "")
local errorBtn  = toolbar:CreateButton("🔴 Explain Error", "Explain & fix a Studio error", "")
local histBtn   = toolbar:CreateButton("📋 Versions", "Browse script version history", "")

-- ─── Create widgets ───────────────────────────────────────────────────────────
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 280, 420, 200, 300)
local widget = plugin:CreateDockWidgetPluginGui("LuaForgeWidget", widgetInfo)
widget.Title = "LuaForge AI"
widget.Enabled = false

mainBtn.Click:Connect(function() widget.Enabled = not widget.Enabled end)

-- ─── State ────────────────────────────────────────────────────────────────────
local authToken  = nil
local wsThread   = nil
local connected  = false
local errorCount = 0  -- unread errors badge

-- ─── Root frame ───────────────────────────────────────────────────────────────
local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = BG
root.BorderSizePixel = 0
root.Parent = widget

local rootPad = Instance.new("UIPadding")
rootPad.PaddingLeft = UDim.new(0, 14); rootPad.PaddingRight  = UDim.new(0, 14)
rootPad.PaddingTop  = UDim.new(0, 14); rootPad.PaddingBottom = UDim.new(0, 14)
rootPad.Parent = root

-- ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
local loginScreen = Instance.new("Frame")
loginScreen.Size = UDim2.new(1, 0, 1, 0); loginScreen.BackgroundTransparency = 1
loginScreen.Visible = true; loginScreen.Parent = root

local logoLbl = makeLabel(loginScreen, "⚡ LuaForge", UDim2.new(1,0,0,28), UDim2.new(0,0,0,0), ACCENT, 20)
logoLbl.Font = Enum.Font.GothamBold
makeLabel(loginScreen, "Sign in to your account", UDim2.new(1,0,0,16), UDim2.new(0,0,0,32), MUTED, 11)
makeLabel(loginScreen, "Username", UDim2.new(1,0,0,14), UDim2.new(0,0,0,56), MUTED, 10)
local usernameBox = makeInput(loginScreen, "your_username", UDim2.new(0,0,0,72))
makeLabel(loginScreen, "Password", UDim2.new(1,0,0,14), UDim2.new(0,0,0,114), MUTED, 10)
local passwordBox = makeInput(loginScreen, "••••••••", UDim2.new(0,0,0,130), true)
local loginError = makeLabel(loginScreen, "", UDim2.new(1,0,0,16), UDim2.new(0,0,0,170), STATUS_ERR, 10)
loginError.TextWrapped = true
local loginBtn = makeButton(loginScreen, "Sign In", UDim2.new(0,0,0,192), UDim2.new(1,0,0,36), true)
local regToggle = makeLabel(loginScreen, "No account? Register →", UDim2.new(1,0,0,14), UDim2.new(0,0,0,236), ACCENT, 10)
regToggle.TextXAlignment = Enum.TextXAlignment.Center

-- ── REGISTER SCREEN ───────────────────────────────────────────────────────────
local regMode = false
local registerScreen = Instance.new("Frame")
registerScreen.Size = UDim2.new(1,0,1,0); registerScreen.BackgroundTransparency = 1
registerScreen.Visible = false; registerScreen.Parent = root

makeLabel(registerScreen, "⚡ LuaForge", UDim2.new(1,0,0,28), UDim2.new(0,0,0,0), ACCENT, 20).Font = Enum.Font.GothamBold
makeLabel(registerScreen, "Create an account", UDim2.new(1,0,0,16), UDim2.new(0,0,0,32), MUTED, 11)
makeLabel(registerScreen, "Username", UDim2.new(1,0,0,14), UDim2.new(0,0,0,56), MUTED, 10)
local regUsernameBox = makeInput(registerScreen, "choose_a_username", UDim2.new(0,0,0,72))
makeLabel(registerScreen, "Password", UDim2.new(1,0,0,14), UDim2.new(0,0,0,114), MUTED, 10)
local regPasswordBox = makeInput(registerScreen, "min 6 characters", UDim2.new(0,0,0,130), true)
local regError = makeLabel(registerScreen, "", UDim2.new(1,0,0,16), UDim2.new(0,0,0,170), STATUS_ERR, 10)
regError.TextWrapped = true
local regBtn = makeButton(registerScreen, "Create Account", UDim2.new(0,0,0,192), UDim2.new(1,0,0,36), true)
local backToggle = makeLabel(registerScreen, "← Back to Sign In", UDim2.new(1,0,0,14), UDim2.new(0,0,0,236), ACCENT, 10)
backToggle.TextXAlignment = Enum.TextXAlignment.Center

-- ── MAIN SCREEN ───────────────────────────────────────────────────────────────
local mainScreen = Instance.new("Frame")
mainScreen.Size = UDim2.new(1,0,1,0); mainScreen.BackgroundTransparency = 1
mainScreen.Visible = false; mainScreen.Parent = root

local headerLbl = makeLabel(mainScreen, "⚡ LuaForge", UDim2.new(1,0,0,22), UDim2.new(0,0,0,0), ACCENT, 16)
headerLbl.Font = Enum.Font.GothamBold
local userLbl = makeLabel(mainScreen, "Signed in as ...", UDim2.new(1,0,0,14), UDim2.new(0,0,0,26), MUTED, 10)

-- Status row
local statusRow = Instance.new("Frame"); statusRow.Size = UDim2.new(1,0,0,28); statusRow.Position = UDim2.new(0,0,0,50); statusRow.BackgroundTransparency = 1; statusRow.Parent = mainScreen
local statusDot = Instance.new("Frame"); statusDot.Size = UDim2.new(0,8,0,8); statusDot.Position = UDim2.new(0,0,0.5,-4); statusDot.BackgroundColor3 = STATUS_ERR; statusDot.BorderSizePixel = 0; statusDot.Parent = statusRow
local dotCorner = Instance.new("UICorner"); dotCorner.CornerRadius = UDim.new(1,0); dotCorner.Parent = statusDot
local statusLbl = makeLabel(statusRow, "Disconnected", UDim2.new(1,-16,1,0), UDim2.new(0,16,0,0), MUTED, 11)

-- NEW: Error badge / notification area
local errorBanner = Instance.new("Frame")
errorBanner.Size = UDim2.new(1,0,0,30)
errorBanner.Position = UDim2.new(0,0,0,85)
errorBanner.BackgroundColor3 = Color3.fromRGB(60, 20, 20)
errorBanner.BorderSizePixel = 0
errorBanner.Visible = false
errorBanner.Parent = mainScreen
local bannerCorner = Instance.new("UICorner"); bannerCorner.CornerRadius = UDim.new(0,6); bannerCorner.Parent = errorBanner
local bannerPad = Instance.new("UIPadding"); bannerPad.PaddingLeft = UDim.new(0,8); bannerPad.PaddingRight = UDim.new(0,8); bannerPad.Parent = errorBanner
local errorBannerLbl = makeLabel(errorBanner, "🔴 0 new errors — click to analyze", UDim2.new(1,0,1,0), UDim2.new(0,0,0,0), STATUS_ERR, 10)
errorBannerLbl.TextXAlignment = Enum.TextXAlignment.Center

local instrLbl = makeLabel(mainScreen, "Open rluaforge.netlify.app → scripts push here automatically.", UDim2.new(1,0,0,40), UDim2.new(0,0,0,122), MUTED, 10)
instrLbl.TextWrapped = true

local reconnectBtn = makeButton(mainScreen, "↻ Reconnect", UDim2.new(0,0,0,168), UDim2.new(0.5,0,0,28))
reconnectBtn.BackgroundColor3 = Color3.fromRGB(30,35,45); reconnectBtn.TextSize = 11

local retryLbl = makeLabel(mainScreen, "", UDim2.new(1,0,0,14), UDim2.new(0,0,0,200), MUTED, 9)
retryLbl.TextXAlignment = Enum.TextXAlignment.Center

-- Log filter toggle
local logFilterToggle = makeButton(mainScreen, "📋 Logs: errors+warns", UDim2.new(0,0,1,-80), UDim2.new(1,0,0,28))
logFilterToggle.BackgroundColor3 = Color3.fromRGB(25,30,42)
logFilterToggle.TextSize = 10
logFilterToggle.TextColor3 = MUTED

local LOG_PRESETS = {
	{ label="errors only",   filter="error" },
	{ label="errors+warns",  filter="error,warn" },
	{ label="all levels",    filter="error,warn,info,print" },
}
local logPresetIdx = 2
local function updateLogFilterBtn()
	local preset = LOG_PRESETS[logPresetIdx]
	logFilterToggle.Text = "📋 Logs: " .. preset.label
	-- Tint button to visually indicate current level
	if preset.filter == "error" then
		logFilterToggle.BackgroundColor3 = Color3.fromRGB(60, 20, 20)
	elseif preset.filter == "error,warn" then
		logFilterToggle.BackgroundColor3 = Color3.fromRGB(40, 35, 15)
	else
		logFilterToggle.BackgroundColor3 = Color3.fromRGB(15, 35, 20)
	end
end
updateLogFilterBtn()

logFilterToggle.MouseButton1Click:Connect(function()
	logPresetIdx = (logPresetIdx % #LOG_PRESETS) + 1
	local preset = LOG_PRESETS[logPresetIdx]
	plugin:SetSetting("luaforge_log_filter", preset.filter)
	LOG_LEVEL_FILTER = loadLogFilter()
	updateLogFilterBtn()
end)

local logoutBtn = makeButton(mainScreen, "Sign Out", UDim2.new(0,0,1,-40), UDim2.new(0.5,0,0,36))
logoutBtn.BackgroundColor3 = SURFACE

-- ─── Auto Console Log Capture ─────────────────────────────────────────────────
-- Hooks into ScriptEditorService to intercept console output and stream to server
local pendingLogs = {}
local LOG_FLUSH_INTERVAL = 3  -- flush every 3 seconds
local lastErrorMessages = {}  -- deduplicate
-- Load user log level preference from plugin settings (persisted across sessions)
local function loadLogFilter()
	local pref = plugin:GetSetting("luaforge_log_filter") or "error,warn"
	local filter = {}
	for level in pref:gmatch("[^,]+") do filter[level:match("^%s*(.-)%s*$")] = true end
	return filter
end
local LOG_LEVEL_FILTER = loadLogFilter()

local function flushLogs()
	if #pendingLogs == 0 or not authToken then return end
	local batch = pendingLogs
	pendingLogs = {}
	pcall(function()
		post("/api/console/log", { logs = batch }, authToken)
	end)
end

local function captureLog(level, message)
	-- Apply log level filter
	if not LOG_LEVEL_FILTER[level] then return end
	-- Deduplicate within 5s window
	local key = level .. message
	if lastErrorMessages[key] and (os.clock() - lastErrorMessages[key]) < 5 then return end
	lastErrorMessages[key] = os.clock()

	table.insert(pendingLogs, {
		level = level,
		message = message,
		timestamp = os.date("!%Y-%m-%dT%H:%M:%SZ"),
	})
	-- Flush errors immediately; batch others
	if level == "error" then
		errorCount = errorCount + 1
		if errorBannerLbl then
			errorBannerLbl.Text = "🔴 " .. errorCount .. " new error" .. (errorCount ~= 1 and "s" or "") .. " — click to analyze"
			errorBanner.Visible = true
		end
		task.spawn(flushLogs)
	end
end

-- Hook LogService for console output
local LogService = game:GetService("LogService")
LogService.MessageOut:Connect(function(message, messageType)
	if not authToken then return end
	local level = "print"
	if messageType == Enum.MessageType.MessageError then level = "error"
	elseif messageType == Enum.MessageType.MessageWarning then level = "warn"
	elseif messageType == Enum.MessageType.MessageInfo then level = "info" end
	captureLog(level, message)
end)

-- Periodic log flush
task.spawn(function()
	while true do
		task.wait(LOG_FLUSH_INTERVAL)
		flushLogs()
	end
end)

-- Error banner click → open error analyzer
errorBanner.InputBegan:Connect(function(input)
	if input.UserInputType == Enum.UserInputType.MouseButton1 then
		errorWidget.Enabled = true
		errorCount = 0
		errorBanner.Visible = false
	end
end)

-- ─── Offline command buffer ──────────────────────────────────────────────────
-- Commands sent while disconnected are buffered and replayed on reconnect
-- Persist offline buffer in plugin settings so it survives restarts
local function loadOfflineBuffer()
	local ok, data = pcall(function()
		return game:GetService("HttpService"):JSONDecode(plugin:GetSetting("luaforge_offline_buf") or "[]")
	end)
	return (ok and type(data) == "table") and data or {}
end
local function saveOfflineBuffer(buf)
	pcall(function()
		plugin:SetSetting("luaforge_offline_buf", game:GetService("HttpService"):JSONEncode(buf))
	end)
end
local offlineCommandBuffer = loadOfflineBuffer()
local MAX_BUFFER = 20

local function bufferOrSend(ws, msg)
	if ws and ws.Connected then
		ws:Send(msg)
	else
		if #offlineCommandBuffer >= MAX_BUFFER then
			table.remove(offlineCommandBuffer, 1)
		end
		table.insert(offlineCommandBuffer, { msg = msg, t = os.time() })
		saveOfflineBuffer(offlineCommandBuffer)
	end
end

local function flushOfflineBuffer(ws)
	if #offlineCommandBuffer == 0 then return end
	-- Sort by timestamp before replaying to preserve order
	table.sort(offlineCommandBuffer, function(a, b)
		return (a.t or 0) < (b.t or 0)
	end)
	for _, entry in ipairs(offlineCommandBuffer) do
		pcall(function() ws:Send(type(entry) == "table" and entry.msg or entry) end)
	end
	offlineCommandBuffer = {}
	saveOfflineBuffer(offlineCommandBuffer)
end

-- ─── WebSocket connection loop ─────────────────────────────────────────────────
local function setConnected(isConnected)
	connected = isConnected
	if isConnected then
		statusDot.BackgroundColor3 = STATUS_OK
		statusLbl.Text = "Connected ✓"
		statusLbl.TextColor3 = STATUS_OK
	else
		statusDot.BackgroundColor3 = STATUS_ERR
		statusLbl.Text = "Disconnected"
		statusLbl.TextColor3 = MUTED
	end
end

local wsReconnectCount = 0
local WS_BACKOFF_BASE  = 2
local WS_BACKOFF_MAX   = 60

local function startWebSocket()
	if wsThread then task.cancel(wsThread) end
	wsThread = task.spawn(function()
		while authToken do
			local ok, err = pcall(function()
				local ws = HttpService:WebSocketConnect(WS_URL .. "?token=" .. HttpService:UrlEncode(authToken))
				wsReconnectCount = 0
				retryLbl.Text = ""
				ws.OnMessage:Connect(function(msg)
					local data = HttpService:JSONDecode(msg)
					if data.type == "connected" then
						setConnected(true)
						task.defer(function() flushOfflineBuffer(ws) end)
					elseif data.type == "kicked" then
						setConnected(false)
					elseif data.type == "token_expired" then
						setConnected(false)
						loginError.Text = "Session expired — please sign in again"
						clearToken()
						task.defer(showLogin)
					elseif data.type == "ping" then
						ws:Send(HttpService:JSONEncode({ type = "pong" }))

					-- NEW: server detected errors from our stream and notified us
					elseif data.type == "error_detected" then
						local errs = data.errors or {}
						errorCount = errorCount + #errs
						if errorBannerLbl then
							errorBannerLbl.Text = "🔴 " .. errorCount .. " error" .. (errorCount ~= 1 and "s" or "") .. " detected — click to analyze"
							errorBanner.Visible = true
						end

					elseif data.type == "inject" then
						local loc = data.location or "ServerScriptService"
						local target = game:GetService(loc)
						if target then
							local inst = Instance.new(data.scriptType or "Script")
							inst.Name = data.scriptName or "LuaForgeScript"
							inst.Source = data.code or ""
							inst.Parent = target
						end

					elseif data.type == "blueprint" then
						local blueprint = data.blueprint
						if blueprint and blueprint.instances then
							local InsertService = game:GetService("InsertService")
							local function applyProperties(inst, props)
								if not props then return end
								for k, v in pairs(props) do
									pcall(function()
										local t = type(v)
										if k == "position" and t == "table" then
											if typeof(inst.Position) == "UDim2" then inst.Position = UDim2.new(v.scaleX or 0,v.offsetX or 0,v.scaleY or 0,v.offsetY or 0)
											else inst.Position = Vector3.new(v.x or 0,v.y or 0,v.z or 0) end
										elseif k == "size" and t == "table" then
											if typeof(inst.Size) == "UDim2" then inst.Size = UDim2.new(v.scaleX or 0,v.offsetX or 0,v.scaleY or 0,v.offsetY or 0)
											else inst.Size = Vector3.new(v.x or 4,v.y or 1,v.z or 4) end
										elseif k == "color" and t == "table" then inst.Color = Color3.fromRGB(v.r or 163,v.g or 163,v.b or 163)
										elseif k == "backgroundColor" and t == "table" then inst.BackgroundColor3 = Color3.fromRGB(v.r or 255,v.g or 255,v.b or 255)
										elseif k == "textColor" and t == "table" then inst.TextColor3 = Color3.fromRGB(v.r or 255,v.g or 255,v.b or 255)
										elseif k == "anchorPoint" and t == "table" then inst.AnchorPoint = Vector2.new(v.x or 0,v.y or 0)
										elseif k == "cornerRadius" and t == "table" then inst.CornerRadius = UDim.new(v.scale or 0,v.offset or 0)
										elseif k == "brickColor" and t == "string" then inst.BrickColor = BrickColor.new(v)
										elseif k == "material" and t == "string" then inst.Material = Enum.Material[v] or Enum.Material.SmoothPlastic
										elseif k == "font" and t == "string" then inst.Font = Enum.Font[v] or Enum.Font.Gotham
										elseif k ~= "children" then pcall(function() inst[k] = v end) end
									end)
								end
							end
							local function buildInstance(instData, parentInst)
								local iType = instData.instanceType
								if not iType then return end
								if iType == "ToolboxModel" then
									local assetId = instData.assetId
									if assetId then pcall(function()
										local model = InsertService:LoadAsset(assetId)
										model.Parent = parentInst
									end) end
									return
								end
								local ok2, newInst = pcall(Instance.new, iType)
								if not ok2 then return end
								newInst.Name = instData.name or "Instance"
								if (iType == "Script" or iType == "LocalScript" or iType == "ModuleScript") and instData.source and instData.source ~= "" then
									newInst.Source = instData.source
								end
								applyProperties(newInst, instData.properties)
								newInst.Parent = parentInst
								if instData.children and type(instData.children) == "table" then
									for _, childData in ipairs(instData.children) do buildInstance(childData, newInst) end
								end
							end
							for _, inst in ipairs(blueprint.instances) do
								pcall(function()
									local loc = inst.location or "Workspace"
									local ok2, svc = pcall(function() return game:GetService(loc) end)
									buildInstance(inst, ok2 and svc or game.Workspace)
								end)
							end
						end

					elseif data.type == "query" then
						local requestId = data.requestId
						task.spawn(function()
							local result = { query = data.query or "" }
							pcall(function()
								local q = (data.query or ""):lower()
								if q:find("part") or q:find("workspace") then
									local parts = {}
									for _, v in ipairs(game.Workspace:GetDescendants()) do
										if v:IsA("BasePart") then
											table.insert(parts, {name=v.Name,class=v.ClassName,position={x=math.floor(v.Position.X),y=math.floor(v.Position.Y),z=math.floor(v.Position.Z)}})
											if #parts >= 50 then break end
										end
									end
									result.parts = parts
								end
								if q:find("player") then
									local players = {}
									for _, p in ipairs(game:GetService("Players"):GetPlayers()) do
										local pos,health = {x=0,y=0,z=0},0
										pcall(function()
											local root = p.Character and p.Character:FindFirstChild("HumanoidRootPart")
											if root then pos = {x=math.floor(root.Position.X),y=math.floor(root.Position.Y),z=math.floor(root.Position.Z)} end
											local hum = p.Character and p.Character:FindFirstChild("Humanoid")
											if hum then health = math.floor(hum.Health) end
										end)
										table.insert(players, {name=p.Name,userId=p.UserId,position=pos,health=health})
									end
									result.players = players
								end
								if q:find("script") then
									local scripts = {}
									for _, svc in ipairs({game:GetService("ServerScriptService"),game:GetService("ReplicatedStorage"),game:GetService("StarterGui")}) do
										for _, v in ipairs(svc:GetDescendants()) do
											if v:IsA("LuaSourceContainer") then table.insert(scripts, {name=v.Name,class=v.ClassName,location=svc.Name}) end
										end
									end
									result.scripts = scripts
								end
							end)
							pcall(function() post("/api/studio/query-result", {requestId=requestId,data=result}, authToken) end)
						end)

					elseif data.type == "sync_read" then
						local requestId = data.requestId
						task.spawn(function()
							local tree = {}
							for _, svc in ipairs({game:GetService("ServerScriptService"),game:GetService("StarterPlayer"),game:GetService("ReplicatedStorage"),game:GetService("StarterGui")}) do
								for _, v in ipairs(svc:GetDescendants()) do
									pcall(function()
										local entry = {name=v.Name,class=v.ClassName,location=svc.Name,path=v:GetFullName()}
										if v:IsA("LuaSourceContainer") then entry.source = v.Source:sub(1,4000) end
										table.insert(tree, entry)
									end)
								end
							end
							pcall(function() post("/api/sync/result", {requestId=requestId,tree=tree}, authToken) end)
						end)

					elseif data.type == "sync_apply" then
						for _, patch in ipairs(data.patches or {}) do
							pcall(function()
								local parent = game:GetService(patch.location or "ServerScriptService")
								local existing = parent:FindFirstChild(patch.name)
								if existing and existing:IsA("LuaSourceContainer") then
									existing.Source = patch.source or ""
								else
									local inst = Instance.new(patch.type or "Script")
									inst.Name = patch.name or "PatchedScript"
									inst.Source = patch.source or ""
									inst.Parent = parent
								end
							end)
						end
					end
				end)
				ws.OnClose:Connect(function() setConnected(false) end)
				while ws do task.wait(25) end
			end)
			if not ok then
				setConnected(false)
				wsReconnectCount = wsReconnectCount + 1
				local delay = math.min(WS_BACKOFF_BASE * (2 ^ (wsReconnectCount - 1)), WS_BACKOFF_MAX)
				retryLbl.Text = string.format("Retry #%d in %ds…", wsReconnectCount, delay)
				task.wait(delay)
			end
		end
	end)
end

reconnectBtn.MouseButton1Click:Connect(function()
	if authToken then retryLbl.Text = "Reconnecting..."; startWebSocket() end
end)

-- ─── Auth flow ────────────────────────────────────────────────────────────────
local function showMain(username)
	loginScreen.Visible = false; registerScreen.Visible = false; mainScreen.Visible = true
	userLbl.Text = "Signed in as " .. username
	startWebSocket()
end

local function showLogin()
	loginScreen.Visible = true; registerScreen.Visible = false; mainScreen.Visible = false
	authToken = nil
	if wsThread then task.cancel(wsThread); wsThread = nil end
	setConnected(false)
end

task.spawn(function()
	local token, username = loadToken()
	if token and username then
		local user = getMe(token)
		if user then authToken = token; showMain(user.username)
		else clearToken() end
	end
end)

regToggle.MouseButton1Click:Connect(function() loginScreen.Visible = false; registerScreen.Visible = true end)
backToggle.MouseButton1Click:Connect(function() registerScreen.Visible = false; loginScreen.Visible = true end)

loginBtn.MouseButton1Click:Connect(function()
	local username = usernameBox.Text:lower():gsub("%s+", "")
	local password = passwordBox._getRealText and passwordBox:_getRealText() or passwordBox.Text
	if username == "" or password == "" then loginError.Text = "Fill in all fields"; return end
	loginBtn.Text = "Signing in..."; loginBtn.Active = false; loginError.Text = ""
	local ok, res = pcall(post, "/api/auth/login", { username=username, password=password })
	loginBtn.Text = "Sign In"; loginBtn.Active = true
	if not ok then loginError.Text = tostring(res):gsub(".*: ", ""); return end
	authToken = res.token; saveToken(res.token, res.user.username); showMain(res.user.username)
end)

regBtn.MouseButton1Click:Connect(function()
	local username = regUsernameBox.Text:lower():gsub("%s+", "")
	local password = regPasswordBox._getRealText and regPasswordBox:_getRealText() or regPasswordBox.Text
	if username == "" or password == "" then regError.Text = "Fill in all fields"; return end
	if #password < 6 then regError.Text = "Password must be at least 6 characters"; return end
	regBtn.Text = "Creating account..."; regBtn.Active = false; regError.Text = ""
	local ok, res = pcall(post, "/api/auth/register", { username=username, password=password })
	regBtn.Text = "Create Account"; regBtn.Active = true
	if not ok then regError.Text = tostring(res):gsub(".*: ", ""); return end
	authToken = res.token; saveToken(res.token, res.user.username); showMain(res.user.username)
end)

logoutBtn.MouseButton1Click:Connect(function()
	clearToken(); showLogin(); usernameBox.Text = ""; loginError.Text = ""
end)

-- ═══════════════════════════════════════════════
--  EXPLAIN ERROR WIDGET (upgraded: pre-fills last error automatically)
-- ═══════════════════════════════════════════════
local errorWidgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Bottom, false, false, 560, 240, 300, 150)
local errorWidget = plugin:CreateDockWidgetPluginGui("LuaForgeErrorHelper", errorWidgetInfo)
errorWidget.Title = "LuaForge — Explain Error"

local ef = Instance.new("Frame"); ef.Size = UDim2.new(1,0,1,0); ef.BackgroundColor3 = BG; ef.BorderSizePixel = 0; ef.Parent = errorWidget
local ep = Instance.new("UIPadding"); ep.PaddingLeft = UDim.new(0,14); ep.PaddingRight = UDim.new(0,14); ep.PaddingTop = UDim.new(0,12); ep.PaddingBottom = UDim.new(0,12); ep.Parent = ef

local errTitle = Instance.new("TextLabel"); errTitle.Size = UDim2.new(1,0,0,18); errTitle.BackgroundTransparency = 1; errTitle.TextColor3 = STATUS_ERR; errTitle.Font = FONT_MAIN; errTitle.TextSize = 12; errTitle.TextXAlignment = Enum.TextXAlignment.Left; errTitle.Text = "🔴 Studio errors are captured automatically — or paste one below"; errTitle.Parent = ef

local errInput = Instance.new("TextBox"); errInput.Size = UDim2.new(1,0,0,52); errInput.Position = UDim2.new(0,0,0,24); errInput.BackgroundColor3 = Color3.fromRGB(11,13,17); errInput.BorderSizePixel = 1; errInput.BorderColor3 = BORDER; errInput.TextColor3 = TEXT; errInput.Font = FONT_MONO; errInput.TextSize = 11; errInput.TextXAlignment = Enum.TextXAlignment.Left; errInput.TextYAlignment = Enum.TextYAlignment.Top; errInput.MultiLine = true; errInput.ClearTextOnFocus = false; errInput.PlaceholderText = "e.g.  ServerScript:42: attempt to index nil with 'FindFirstChild'"; errInput.PlaceholderColor3 = MUTED; errInput.Text = ""; errInput.Parent = ef
local instance_corner = Instance.new("UICorner"); instance_corner.CornerRadius = UDim.new(0,6); instance_corner.Parent = errInput

local fixBtn = Instance.new("TextButton"); fixBtn.Size = UDim2.new(0,200,0,28); fixBtn.Position = UDim2.new(0,0,0,82); fixBtn.BackgroundColor3 = STATUS_ERR; fixBtn.TextColor3 = Color3.fromRGB(0,0,0); fixBtn.Font = FONT_MAIN; fixBtn.TextSize = 12; fixBtn.Text = "🔴 Explain & Fix This Error"; fixBtn.BorderSizePixel = 0; fixBtn.AutoButtonColor = true; fixBtn.Parent = ef
local fixCorner = Instance.new("UICorner"); fixCorner.CornerRadius = UDim.new(0,6); fixCorner.Parent = fixBtn

local errResult = Instance.new("TextLabel"); errResult.Size = UDim2.new(1,0,1,-116); errResult.Position = UDim2.new(0,0,0,116); errResult.BackgroundTransparency = 1; errResult.TextColor3 = MUTED; errResult.Font = FONT_MONO; errResult.TextSize = 10; errResult.TextXAlignment = Enum.TextXAlignment.Left; errResult.TextYAlignment = Enum.TextYAlignment.Top; errResult.TextWrapped = true; errResult.Text = "Result will appear here..."; errResult.Parent = ef

errorBtn.Click:Connect(function() errorWidget.Enabled = not errorWidget.Enabled end)

-- Auto-fill last captured error when widget opens
errorWidget:GetPropertyChangedSignal("Enabled"):Connect(function()
	if errorWidget.Enabled then
		-- Find the last error from the buffer
		for i = #pendingLogs, 1, -1 do
			if pendingLogs[i].level == "error" then
				errInput.Text = pendingLogs[i].message
				break
			end
		end
	end
end)

fixBtn.MouseButton1Click:Connect(function()
	local errorText = errInput.Text:gsub("^%s+",""):gsub("%s+$","")
	if errorText == "" then errResult.Text = "⚠ Paste an error message first!"; errResult.TextColor3 = STATUS_WARN; return end
	if not authToken then errResult.Text = "⚠ Not logged in. Open the LuaForge panel and sign in first."; errResult.TextColor3 = STATUS_ERR; return end
	fixBtn.Text = "⏳ Asking AI..."; fixBtn.BackgroundColor3 = BORDER; errResult.Text = "Sending error to AI..."; errResult.TextColor3 = MUTED
	local ok, result = pcall(function()
		return HttpService:RequestAsync({
			Url = SERVER_URL .. "/api/explain-error",
			Method = "POST",
			Headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. authToken },
			Body = HttpService:JSONEncode({ error = errorText }),
		})
	end)
	fixBtn.Text = "🔴 Explain & Fix This Error"; fixBtn.BackgroundColor3 = STATUS_ERR
	if ok and result and result.Success then
		local parseOk, data = pcall(function() return HttpService:JSONDecode(result.Body) end)
		if parseOk and data and data.explanation then
			errResult.Text = data.explanation; errResult.TextColor3 = STATUS_OK
		else errResult.Text = "⚠ Could not parse response"; errResult.TextColor3 = STATUS_ERR end
	else
		local errMsg = ok and (result and tostring(result.StatusCode)) or tostring(result)
		errResult.Text = "⚠ Request failed: " .. errMsg; errResult.TextColor3 = STATUS_ERR
	end
end)

-- ═══════════════════════════════════════════════
--  NEW: VERSION HISTORY WIDGET
-- ═══════════════════════════════════════════════
local histWidgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 300, 500, 200, 300)
local histWidget = plugin:CreateDockWidgetPluginGui("LuaForgeVersions", histWidgetInfo)
histWidget.Title = "LuaForge — Version History"

local hf = Instance.new("Frame"); hf.Size = UDim2.new(1,0,1,0); hf.BackgroundColor3 = BG; hf.BorderSizePixel = 0; hf.Parent = histWidget
local hp = Instance.new("UIPadding"); hp.PaddingLeft = UDim.new(0,12); hp.PaddingRight = UDim.new(0,12); hp.PaddingTop = UDim.new(0,12); hp.PaddingBottom = UDim.new(0,12); hp.Parent = hf

makeLabel(hf, "📋 Version History", UDim2.new(1,0,0,20), UDim2.new(0,0,0,0), ACCENT, 14).Font = Enum.Font.GothamBold
makeLabel(hf, "Browse and restore any past script version.", UDim2.new(1,0,0,16), UDim2.new(0,0,0,24), MUTED, 10)

local scriptNameInput = makeInput(hf, "script name to browse…", UDim2.new(0,0,0,48))
scriptNameInput.Size = UDim2.new(1,0,0,30)

local browseBtn = makeButton(hf, "Browse Versions", UDim2.new(0,0,0,84), UDim2.new(1,0,0,28), false)
browseBtn.TextSize = 11

local histStatus = makeLabel(hf, "", UDim2.new(1,0,0,14), UDim2.new(0,0,0,118), MUTED, 10)
histStatus.TextWrapped = true

-- Scrollable list for versions
local listFrame = Instance.new("ScrollingFrame")
listFrame.Size = UDim2.new(1,0,1,-170)
listFrame.Position = UDim2.new(0,0,0,138)
listFrame.BackgroundTransparency = 1
listFrame.BorderSizePixel = 0
listFrame.ScrollBarThickness = 4
listFrame.CanvasSize = UDim2.new(0,0,0,0)
listFrame.AutomaticCanvasSize = Enum.AutomaticSize.Y
listFrame.Parent = hf

local listLayout = Instance.new("UIListLayout"); listLayout.SortOrder = Enum.SortOrder.LayoutOrder; listLayout.Padding = UDim.new(0,6); listLayout.Parent = listFrame

local function clearList()
	for _, c in ipairs(listFrame:GetChildren()) do
		if not c:IsA("UIListLayout") then c:Destroy() end
	end
end

local function addVersionEntry(vData, index)
	local card = Instance.new("Frame")
	card.Size = UDim2.new(1,0,0,68)
	card.BackgroundColor3 = SURFACE
	card.BorderSizePixel = 0
	card.LayoutOrder = index
	card.Parent = listFrame

	local cardCorner = Instance.new("UICorner"); cardCorner.CornerRadius = UDim.new(0,6); cardCorner.Parent = card
	local cardPad = Instance.new("UIPadding"); cardPad.PaddingLeft = UDim.new(0,8); cardPad.PaddingRight = UDim.new(0,8); cardPad.PaddingTop = UDim.new(0,6); cardPad.PaddingBottom = UDim.new(0,6); cardPad.Parent = card

	makeLabel(card, "v" .. index .. " — " .. (vData.scriptType or "Script"), UDim2.new(1,0,0,14), UDim2.new(0,0,0,0), ACCENT, 10)
	local dateStr = (vData.createdAt or ""):sub(1,16):gsub("T"," ")
	makeLabel(card, dateStr, UDim2.new(1,0,0,12), UDim2.new(0,0,0,16), MUTED, 9)
	local previewLbl = makeLabel(card, vData.codePreview or "", UDim2.new(1,0,0,14), UDim2.new(0,0,0,30), MUTED, 9)
	previewLbl.Font = FONT_MONO; previewLbl.TextWrapped = true

	local restoreBtn = makeButton(card, "↩ Restore", UDim2.new(0,0,0,46), UDim2.new(0.5,0,0,20))
	restoreBtn.TextSize = 10; restoreBtn.BackgroundColor3 = Color3.fromRGB(30,55,40)
	restoreBtn.TextColor3 = STATUS_OK

	-- Fetch and show a basic char-count diff hint before restoring
	local diffLbl = makeLabel(card, "", UDim2.new(1,0,0,10), UDim2.new(0,0,0,56), MUTED, 8)
	diffLbl.Font = FONT_MONO
	diffLbl.Text = string.format("~%d chars · preview not available in Studio", vData.codeLength or 0)

	restoreBtn.MouseButton1Click:Connect(function()
		if not authToken then histStatus.Text = "⚠ Not logged in"; return end
		restoreBtn.Text = "↩ Restoring…"; restoreBtn.Active = false
		local ok, res = pcall(function()
			return HttpService:RequestAsync({
				Url = SERVER_URL .. "/api/versions/restore",
				Method = "POST",
				Headers = { ["Content-Type"] = "application/json", ["Authorization"] = "Bearer " .. authToken },
				Body = HttpService:JSONEncode({ versionId = vData.id }),
			})
		end)
		restoreBtn.Text = "↩ Restore"; restoreBtn.Active = true
		if ok and res and res.Success then
			local data = HttpService:JSONDecode(res.Body)
			if data.pushed then histStatus.Text = "✓ Restored and pushed to Studio!"
			else histStatus.Text = "✓ Restored (connect Studio to push)" end
			histStatus.TextColor3 = STATUS_OK
		else
			histStatus.Text = "⚠ Restore failed"; histStatus.TextColor3 = STATUS_ERR
		end
	end)
end

browseBtn.MouseButton1Click:Connect(function()
	if not authToken then histStatus.Text = "⚠ Not logged in"; return end
	local name = scriptNameInput.Text:gsub("^%s+",""):gsub("%s+$","")
	if name == "" then histStatus.Text = "Enter a script name first"; histStatus.TextColor3 = STATUS_WARN; return end

	browseBtn.Text = "Loading…"; browseBtn.Active = false
	clearList()
	histStatus.Text = ""

	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = SERVER_URL .. "/api/versions/" .. HttpService:UrlEncode(name),
			Method = "GET",
			Headers = { ["Authorization"] = "Bearer " .. authToken },
		})
	end)
	browseBtn.Text = "Browse Versions"; browseBtn.Active = true

	if ok and res and res.Success then
		local data = HttpService:JSONDecode(res.Body)
		local versions = data.versions or {}
		if #versions == 0 then
			histStatus.Text = "No versions found for '" .. name .. "'"
			histStatus.TextColor3 = MUTED
		else
			histStatus.Text = #versions .. " version(s) found:"
			histStatus.TextColor3 = STATUS_OK
			for i, v in ipairs(versions) do
				addVersionEntry(v, i)
			end
		end
	else
		histStatus.Text = "⚠ Failed to load versions"
		histStatus.TextColor3 = STATUS_ERR
	end
end)

histBtn.Click:Connect(function() histWidget.Enabled = not histWidget.Enabled end)
