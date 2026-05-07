-- LuaForge Studio Plugin v2 — Built-in Login Screen
-- Paste this into Roblox Studio → Plugin → Script (or install as .rbxmx)
-- No more manual token pasting — the plugin logs you in and stores the session permanently.

local HttpService   = game:GetService("HttpService")
local RunService    = game:GetService("RunService")
local StudioService = game:GetService("StudioService")

-- ─── CONFIG ──────────────────────────────────────────────────────────────────
local SERVER_URL = "https://luaforge-production-b226.up.railway.app"
local WS_URL     = "wss://luaforge-production-b226.up.railway.app"

-- ─── Plugin storage (persists across Studio sessions) ────────────────────────
local STORAGE_KEY_TOKEN    = "luaforge_auth_token"
local STORAGE_KEY_USERNAME = "luaforge_username"

local plugin = plugin  -- injected by Roblox when script runs as plugin

local function saveToken(token, username)
	plugin:SetSetting(STORAGE_KEY_TOKEN,    token)
	plugin:SetSetting(STORAGE_KEY_USERNAME, username)
end

local function loadToken()
	return plugin:GetSetting(STORAGE_KEY_TOKEN),
	       plugin:GetSetting(STORAGE_KEY_USERNAME)
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

local function getMe(token)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url    = SERVER_URL .. "/api/auth/me",
			Method = "GET",
			Headers = { Authorization = "Bearer " .. token },
		})
	end)
	if not ok then return nil end
	if not res.Success then return nil end
	return HttpService:JSONDecode(res.Body)
end

-- ─── GUI Builder ─────────────────────────────────────────────────────────────
local widget       -- DockWidgetPluginGui
local screenGui    -- ScreenGui inside widget

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
	if isPassword then box.TextTransparency = 1; box.Text = "" end  -- mask trick
	box.Parent = parent

	-- border frame
	local border = Instance.new("Frame")
	border.Size = UDim2.new(1, 2, 1, 2)
	border.Position = UDim2.new(0, -1, 0, -1)
	border.BackgroundColor3 = BORDER
	border.BorderSizePixel = 0
	border.ZIndex = box.ZIndex - 1
	border.Parent = parent

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 6)
	corner.Parent = box

	local pad = Instance.new("UIPadding")
	pad.PaddingLeft = UDim.new(0, 10)
	pad.Parent = box

	if isPassword then
		-- Simple masking: on changed, replace visible text with dots
		local realText = ""
		box:GetPropertyChangedSignal("Text"):Connect(function()
			local raw = box.Text
			if #raw >= #realText then
				realText = realText .. raw:sub(#realText + 1)
			else
				realText = realText:sub(1, #raw)
			end
			box.Text = string.rep("•", #realText)
			box:GetPropertyChangedSignal("Text"):Wait() -- prevent loop
		end)
		-- expose real text via attribute
		box:SetAttribute("realText", "")
		box:GetPropertyChangedSignal("Text"):Connect(function()
			box:SetAttribute("realText", realText)
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

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 8)
	corner.Parent = btn

	return btn
end

-- ─── Plugin toolbar ───────────────────────────────────────────────────────────
local toolbar  = plugin:CreateToolbar("LuaForge")
local mainBtn  = toolbar:CreateButton("LuaForge", "Open LuaForge AI Panel", "")
local errorBtn = toolbar:CreateButton("🔴 Explain Error", "Paste a Studio error — AI explains and fixes it", "")

-- ─── Create widget ────────────────────────────────────────────────────────────
local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false, false,
	280, 420, 200, 300
)
widget = plugin:CreateDockWidgetPluginGui("LuaForgeWidget", widgetInfo)
widget.Title = "LuaForge AI"
widget.Enabled = false

mainBtn.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

-- ─── State ────────────────────────────────────────────────────────────────────
local authToken  = nil
local wsThread   = nil
local connected  = false

-- ─── UI ───────────────────────────────────────────────────────────────────────
local root = Instance.new("Frame")
root.Size = UDim2.new(1, 0, 1, 0)
root.BackgroundColor3 = BG
root.BorderSizePixel = 0
root.Parent = widget

local rootPad = Instance.new("UIPadding")
rootPad.PaddingLeft   = UDim.new(0, 14)
rootPad.PaddingRight  = UDim.new(0, 14)
rootPad.PaddingTop    = UDim.new(0, 14)
rootPad.PaddingBottom = UDim.new(0, 14)
rootPad.Parent = root

-- ── LOGIN SCREEN ──────────────────────────────────────────────────────────────
local loginScreen = Instance.new("Frame")
loginScreen.Size = UDim2.new(1, 0, 1, 0)
loginScreen.BackgroundTransparency = 1
loginScreen.Visible = true
loginScreen.Parent = root

local logoLbl = makeLabel(loginScreen, "⚡ LuaForge", UDim2.new(1, 0, 0, 28), UDim2.new(0, 0, 0, 0), ACCENT, 20)
logoLbl.Font = Enum.Font.GothamBold

makeLabel(loginScreen, "Sign in to your account", UDim2.new(1, 0, 0, 16), UDim2.new(0, 0, 0, 32), MUTED, 11)

-- Username
makeLabel(loginScreen, "Username", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 56), MUTED, 10)
local usernameBox = makeInput(loginScreen, "your_username", UDim2.new(0, 0, 0, 72))

-- Password
makeLabel(loginScreen, "Password", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 114), MUTED, 10)
local passwordBox = makeInput(loginScreen, "••••••••", UDim2.new(0, 0, 0, 130), true)

-- Error label
local loginError = makeLabel(loginScreen, "", UDim2.new(1, 0, 0, 16), UDim2.new(0, 0, 0, 170), STATUS_ERR, 10)
loginError.TextWrapped = true

-- Login button
local loginBtn = makeButton(loginScreen, "Sign In", UDim2.new(0, 0, 0, 192), UDim2.new(1, 0, 0, 36), true)

-- Register toggle
local regToggle = makeLabel(loginScreen, "No account? Register →", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 236), ACCENT, 10)
regToggle.TextXAlignment = Enum.TextXAlignment.Center

-- Register fields (hidden by default)
local regMode = false
local registerScreen = Instance.new("Frame")
registerScreen.Size = UDim2.new(1, 0, 1, 0)
registerScreen.BackgroundTransparency = 1
registerScreen.Visible = false
registerScreen.Parent = root

makeLabel(registerScreen, "⚡ LuaForge", UDim2.new(1, 0, 0, 28), UDim2.new(0, 0, 0, 0), ACCENT, 20).Font = Enum.Font.GothamBold
makeLabel(registerScreen, "Create an account", UDim2.new(1, 0, 0, 16), UDim2.new(0, 0, 0, 32), MUTED, 11)

makeLabel(registerScreen, "Username", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 56), MUTED, 10)
local regUsernameBox = makeInput(registerScreen, "choose_a_username", UDim2.new(0, 0, 0, 72))

makeLabel(registerScreen, "Password", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 114), MUTED, 10)
local regPasswordBox = makeInput(registerScreen, "min 6 characters", UDim2.new(0, 0, 0, 130), true)

local regError = makeLabel(registerScreen, "", UDim2.new(1, 0, 0, 16), UDim2.new(0, 0, 0, 170), STATUS_ERR, 10)
regError.TextWrapped = true

local regBtn = makeButton(registerScreen, "Create Account", UDim2.new(0, 0, 0, 192), UDim2.new(1, 0, 0, 36), true)
local backToggle = makeLabel(registerScreen, "← Back to Sign In", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 236), ACCENT, 10)
backToggle.TextXAlignment = Enum.TextXAlignment.Center

-- ── MAIN SCREEN ───────────────────────────────────────────────────────────────
local mainScreen = Instance.new("Frame")
mainScreen.Size = UDim2.new(1, 0, 1, 0)
mainScreen.BackgroundTransparency = 1
mainScreen.Visible = false
mainScreen.Parent = root

-- Header
local headerLbl = makeLabel(mainScreen, "⚡ LuaForge", UDim2.new(1, 0, 0, 22), UDim2.new(0, 0, 0, 0), ACCENT, 16)
headerLbl.Font = Enum.Font.GothamBold

local userLbl = makeLabel(mainScreen, "Signed in as ...", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 26), MUTED, 10)

-- Status dot
local statusRow = Instance.new("Frame")
statusRow.Size = UDim2.new(1, 0, 0, 28)
statusRow.Position = UDim2.new(0, 0, 0, 50)
statusRow.BackgroundTransparency = 1
statusRow.Parent = mainScreen

local statusDot = Instance.new("Frame")
statusDot.Size = UDim2.new(0, 8, 0, 8)
statusDot.Position = UDim2.new(0, 0, 0.5, -4)
statusDot.BackgroundColor3 = STATUS_ERR
statusDot.BorderSizePixel = 0
statusDot.Parent = statusRow
local dotCorner = Instance.new("UICorner"); dotCorner.CornerRadius = UDim.new(1, 0); dotCorner.Parent = statusDot

local statusLbl = makeLabel(statusRow, "Disconnected", UDim2.new(1, -16, 1, 0), UDim2.new(0, 16, 0, 0), MUTED, 11)

-- Instructions
local instrLbl = makeLabel(mainScreen, "Open rluaforge.netlify.app and use Auto Build — scripts appear here automatically.", UDim2.new(1, 0, 0, 50), UDim2.new(0, 0, 0, 88), MUTED, 10)
instrLbl.TextWrapped = true

-- Reconnect button (manually force a fresh WS connection)
local reconnectBtn = makeButton(mainScreen, "↻ Reconnect", UDim2.new(0, 0, 0, 145), UDim2.new(0.5, 0, 0, 28))
reconnectBtn.BackgroundColor3 = Color3.fromRGB(30, 35, 45)
reconnectBtn.TextSize = 11

-- Retry counter label
local retryLbl = makeLabel(mainScreen, "", UDim2.new(1, 0, 0, 14), UDim2.new(0, 0, 0, 178), MUTED, 9)
retryLbl.TextXAlignment = Enum.TextXAlignment.Center

-- Logout
local logoutBtn = makeButton(mainScreen, "Sign Out", UDim2.new(0, 0, 1, -40), UDim2.new(0.5, 0, 0, 36))
logoutBtn.BackgroundColor3 = SURFACE

-- ─── WebSocket connection loop ─────────────────────────────────────────────────
local function setConnected(isConnected)
	connected = isConnected
	if isConnected then
		statusDot.BackgroundColor3  = STATUS_OK
		statusLbl.Text = "Connected ✓"
		statusLbl.TextColor3 = STATUS_OK
	else
		statusDot.BackgroundColor3  = STATUS_ERR
		statusLbl.Text = "Disconnected"
		statusLbl.TextColor3 = MUTED
	end
end

local wsReconnectCount = 0

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
					elseif data.type == "kicked" then
						setConnected(false)
					elseif data.type == "ping" then
						ws:Send(HttpService:JSONEncode({ type = "pong" }))
					elseif data.type == "inject" then
						-- Single script inject
						local loc = data.location or "ServerScriptService"
						local target = game:GetService(loc)
						if target then
							local sType = data.scriptType or "Script"
							local inst = Instance.new(sType)
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
											if typeof(inst.Position) == "UDim2" then
												inst.Position = UDim2.new(v.scaleX or 0, v.offsetX or 0, v.scaleY or 0, v.offsetY or 0)
											else
												inst.Position = Vector3.new(v.x or 0, v.y or 0, v.z or 0)
											end
										elseif k == "size" and t == "table" then
											if typeof(inst.Size) == "UDim2" then
												inst.Size = UDim2.new(v.scaleX or 0, v.offsetX or 0, v.scaleY or 0, v.offsetY or 0)
											else
												inst.Size = Vector3.new(v.x or 4, v.y or 1, v.z or 4)
											end
										elseif (k == "Size" or k == "size") and t == "table" and typeof(inst.Size) == "UDim2" then
											inst.Size = UDim2.new(v.scaleX or 0, v.offsetX or 0, v.scaleY or 0, v.offsetY or 0)
										elseif (k == "Position" or k == "position") and t == "table" and typeof(inst.Position) == "UDim2" then
											inst.Position = UDim2.new(v.scaleX or 0, v.offsetX or 0, v.scaleY or 0, v.offsetY or 0)
										elseif k == "color" and t == "table" then
											inst.Color = Color3.fromRGB(v.r or 163, v.g or 163, v.b or 163)
										elseif k == "backgroundColor" and t == "table" then
											inst.BackgroundColor3 = Color3.fromRGB(v.r or 255, v.g or 255, v.b or 255)
										elseif k == "textColor" and t == "table" then
											inst.TextColor3 = Color3.fromRGB(v.r or 255, v.g or 255, v.b or 255)
										elseif k == "anchorPoint" and t == "table" then
											inst.AnchorPoint = Vector2.new(v.x or 0, v.y or 0)
										elseif k == "cornerRadius" and t == "table" then
											inst.CornerRadius = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "brickColor" and t == "string" then
											inst.BrickColor = BrickColor.new(v)
										elseif k == "material" and t == "string" then
											inst.Material = Enum.Material[v] or Enum.Material.SmoothPlastic
										elseif k == "font" and t == "string" then
											inst.Font = Enum.Font[v] or Enum.Font.Gotham
										elseif k == "fillDirection" and t == "string" then
											inst.FillDirection = Enum.FillDirection[v] or Enum.FillDirection.Vertical
										elseif k == "horizontalAlignment" and t == "string" then
											inst.HorizontalAlignment = Enum.HorizontalAlignment[v] or Enum.HorizontalAlignment.Center
										elseif k == "sortOrder" and t == "string" then
											inst.SortOrder = Enum.SortOrder[v] or Enum.SortOrder.LayoutOrder
										elseif k == "padding" and t == "table" then
											inst.Padding = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "paddingTop" and t == "table" then
											inst.PaddingTop = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "paddingBottom" and t == "table" then
											inst.PaddingBottom = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "paddingLeft" and t == "table" then
											inst.PaddingLeft = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "paddingRight" and t == "table" then
											inst.PaddingRight = UDim.new(v.scale or 0, v.offset or 0)
										elseif k == "color" and t == "table" then
											pcall(function() inst.Color = Color3.fromRGB(v.r or 0, v.g or 0, v.b or 0) end)
										elseif k ~= "children" then
											pcall(function() inst[k] = v end)
										end
									end)
								end
							end

							local function buildInstance(instData, parentInst)
								local iType = instData.instanceType
								if not iType then return end

								if iType == "ToolboxModel" then
									local assetId = instData.assetId
									if assetId then
										pcall(function()
											local model = InsertService:LoadAsset(assetId)
											if instData.properties and instData.properties.position then
												local p = instData.properties.position
												for _, child in ipairs(model:GetChildren()) do
													if child:IsA("BasePart") then
														child.Position = Vector3.new(p.x or 0, p.y or 0, p.z or 0)
													end
												end
											end
											model.Parent = parentInst
										end)
									end
									return
								end

								local ok, newInst = pcall(Instance.new, iType)
								if not ok then return end
								newInst.Name = instData.name or "Instance"

								if (iType == "Script" or iType == "LocalScript" or iType == "ModuleScript") and instData.source and instData.source ~= "" then
									newInst.Source = instData.source
								end

								applyProperties(newInst, instData.properties)

								newInst.Parent = parentInst

								if instData.children and type(instData.children) == "table" then
									for _, childData in ipairs(instData.children) do
										buildInstance(childData, newInst)
									end
								end
							end

							for _, inst in ipairs(blueprint.instances) do
								pcall(function()
									local loc = inst.location or "Workspace"
									local parent
									local ok, svc = pcall(function() return game:GetService(loc) end)
									parent = ok and svc or game.Workspace
									buildInstance(inst, parent)
								end)
							end
						end
					end
				end)
				elseif data.type == "query" then
					local requestId = data.requestId
					local query = data.query or ""
					task.spawn(function()
						local result = { query = query }
						pcall(function()
							if query:lower():find("part") or query:lower():find("workspace") then
								local parts = {}
								for _, v in ipairs(game.Workspace:GetDescendants()) do
									if v:IsA("BasePart") then
										table.insert(parts, {name=v.Name, class=v.ClassName, position={x=math.floor(v.Position.X),y=math.floor(v.Position.Y),z=math.floor(v.Position.Z)}})
										if #parts >= 50 then break end
									end
								end
								result.parts = parts
							end
							if query:lower():find("player") then
								local players = {}
								for _, p in ipairs(game:GetService("Players"):GetPlayers()) do
									local pos = {x=0,y=0,z=0}
									local health = 0
									pcall(function()
										local root = p.Character and p.Character:FindFirstChild("HumanoidRootPart")
										if root then pos = {x=math.floor(root.Position.X),y=math.floor(root.Position.Y),z=math.floor(root.Position.Z)} end
										local hum = p.Character and p.Character:FindFirstChild("Humanoid")
										if hum then health = math.floor(hum.Health) end
									end)
									table.insert(players, {name=p.Name, userId=p.UserId, position=pos, health=health})
								end
								result.players = players
							end
							if query:lower():find("script") then
								local scripts = {}
								for _, svc in ipairs({game:GetService("ServerScriptService"), game:GetService("ReplicatedStorage"), game:GetService("StarterGui")}) do
									for _, v in ipairs(svc:GetDescendants()) do
										if v:IsA("LuaSourceContainer") then
											table.insert(scripts, {name=v.Name, class=v.ClassName, location=svc.Name})
										end
								end
								end
								result.scripts = scripts
							end
						end)
						pcall(function() post("/api/studio/query-result", {requestId=requestId, data=result}, authToken) end)
					end)
				elseif data.type == "sync_read" then
					local requestId = data.requestId
					task.spawn(function()
						local tree = {}
						for _, svc in ipairs({game:GetService("ServerScriptService"), game:GetService("StarterPlayer"), game:GetService("ReplicatedStorage"), game:GetService("StarterGui")}) do
							for _, v in ipairs(svc:GetDescendants()) do
								pcall(function()
									local entry = {name=v.Name, class=v.ClassName, location=svc.Name, path=v:GetFullName()}
									if v:IsA("LuaSourceContainer") then entry.source = v.Source:sub(1, 4000) end
									table.insert(tree, entry)
								end)
							end
						end
						pcall(function() post("/api/sync/result", {requestId=requestId, tree=tree}, authToken) end)
					end)
				elseif data.type == "sync_apply" then
					local patches = data.patches or {}
					for _, patch in ipairs(patches) do
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
				ws.OnClose:Connect(function()
					setConnected(false)
				end)
				while ws do task.wait(25) end
			end)
			if not ok then
				setConnected(false)
				wsReconnectCount = wsReconnectCount + 1
				retryLbl.Text = "Reconnect attempt #" .. wsReconnectCount
				task.wait(5)
			end
		end
	end)
end

-- Manual reconnect button handler
reconnectBtn.MouseButton1Click:Connect(function()
	if authToken then
		retryLbl.Text = "Reconnecting..."
		startWebSocket()
	end
end)

-- ─── Auth flow ────────────────────────────────────────────────────────────────
local function showMain(username)
	loginScreen.Visible    = false
	registerScreen.Visible = false
	mainScreen.Visible     = true
	userLbl.Text = "Signed in as " .. username
	startWebSocket()
end

local function showLogin()
	loginScreen.Visible    = true
	registerScreen.Visible = false
	mainScreen.Visible     = false
	authToken = nil
	if wsThread then task.cancel(wsThread); wsThread = nil end
	setConnected(false)
end

-- Auto-login from stored token
task.spawn(function()
	local token, username = loadToken()
	if token and username then
		local user = getMe(token)
		if user then
			authToken = token
			showMain(user.username)
		else
			clearToken()
		end
	end
end)

-- Toggle between login / register
regToggle.MouseButton1Click:Connect(function()
	loginScreen.Visible    = false
	registerScreen.Visible = true
end)

backToggle.MouseButton1Click:Connect(function()
	registerScreen.Visible = false
	loginScreen.Visible    = true
end)

-- Login button
loginBtn.MouseButton1Click:Connect(function()
	local username = usernameBox.Text:lower():gsub("%s+", "")
	local password = passwordBox._getRealText and passwordBox:_getRealText() or passwordBox.Text
	if username == "" or password == "" then
		loginError.Text = "Fill in all fields"
		return
	end
	loginBtn.Text = "Signing in..."
	loginBtn.Active = false
	loginError.Text = ""
	local ok, res = pcall(post, "/api/auth/login", { username = username, password = password })
	loginBtn.Text = "Sign In"
	loginBtn.Active = true
	if not ok then
		loginError.Text = tostring(res):gsub(".*: ", "")
		return
	end
	authToken = res.token
	saveToken(res.token, res.user.username)
	showMain(res.user.username)
end)

-- Register button
regBtn.MouseButton1Click:Connect(function()
	local username = regUsernameBox.Text:lower():gsub("%s+", "")
	local password = regPasswordBox._getRealText and regPasswordBox:_getRealText() or regPasswordBox.Text
	if username == "" or password == "" then
		regError.Text = "Fill in all fields"
		return
	end
	if #password < 6 then regError.Text = "Password must be at least 6 characters"; return end
	regBtn.Text = "Creating account..."
	regBtn.Active = false
	regError.Text = ""
	local ok, res = pcall(post, "/api/auth/register", { username = username, password = password })
	regBtn.Text = "Create Account"
	regBtn.Active = true
	if not ok then
		regError.Text = tostring(res):gsub(".*: ", "")
		return
	end
	authToken = res.token
	saveToken(res.token, res.user.username)
	showMain(res.user.username)
end)

-- Logout button
logoutBtn.MouseButton1Click:Connect(function()
	clearToken()
	showLogin()
	usernameBox.Text = ""
	loginError.Text  = ""
end)

-- ═══════════════════════════════════════════════
--  EXPLAIN THIS ERROR (Feature 4)
-- ═══════════════════════════════════════════════
local errorWidgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Bottom, false, false, 560, 220, 300, 150
)
local errorWidget = plugin:CreateDockWidgetPluginGui("LuaForgeErrorHelper", errorWidgetInfo)
errorWidget.Title = "LuaForge — Explain Error"

local ef = Instance.new("Frame")
ef.Size = UDim2.new(1,0,1,0)
ef.BackgroundColor3 = BG
ef.BorderSizePixel = 0
ef.Parent = errorWidget

local ep = Instance.new("UIPadding")
ep.PaddingLeft = UDim.new(0,14); ep.PaddingRight = UDim.new(0,14)
ep.PaddingTop = UDim.new(0,12); ep.PaddingBottom = UDim.new(0,12)
ep.Parent = ef

local errTitle = Instance.new("TextLabel")
errTitle.Size = UDim2.new(1,0,0,18)
errTitle.BackgroundTransparency = 1
errTitle.TextColor3 = STATUS_ERR
errTitle.Font = FONT_MAIN
errTitle.TextSize = 12
errTitle.TextXAlignment = Enum.TextXAlignment.Left
errTitle.Text = "🔴 Paste your Studio error → AI will explain and fix it"
errTitle.Parent = ef

local errInput = Instance.new("TextBox")
errInput.Size = UDim2.new(1,0,0,56)
errInput.Position = UDim2.new(0,0,0,24)
errInput.BackgroundColor3 = Color3.fromRGB(11,13,17)
errInput.BorderSizePixel = 1
errInput.BorderColor3 = BORDER
errInput.TextColor3 = TEXT
errInput.Font = FONT_MONO
errInput.TextSize = 11
errInput.TextXAlignment = Enum.TextXAlignment.Left
errInput.TextYAlignment = Enum.TextYAlignment.Top
errInput.MultiLine = true
errInput.ClearTextOnFocus = false
errInput.PlaceholderText = "e.g.  ServerScript:42: attempt to index nil with 'FindFirstChild'"
errInput.PlaceholderColor3 = MUTED
errInput.Text = ""
errInput.Parent = ef

local instance_corner = Instance.new("UICorner")
instance_corner.CornerRadius = UDim.new(0,6)
instance_corner.Parent = errInput

local fixBtn = Instance.new("TextButton")
fixBtn.Size = UDim2.new(0,200,0,28)
fixBtn.Position = UDim2.new(0,0,0,86)
fixBtn.BackgroundColor3 = STATUS_ERR
fixBtn.TextColor3 = Color3.fromRGB(0,0,0)
fixBtn.Font = FONT_MAIN
fixBtn.TextSize = 12
fixBtn.Text = "🔴 Explain & Fix This Error"
fixBtn.BorderSizePixel = 0
fixBtn.AutoButtonColor = true
fixBtn.Parent = ef

local fixCorner = Instance.new("UICorner")
fixCorner.CornerRadius = UDim.new(0,6)
fixCorner.Parent = fixBtn

local errResult = Instance.new("TextLabel")
errResult.Size = UDim2.new(1,0,1,-120)
errResult.Position = UDim2.new(0,0,0,120)
errResult.BackgroundTransparency = 1
errResult.TextColor3 = MUTED
errResult.Font = FONT_MONO
errResult.TextSize = 10
errResult.TextXAlignment = Enum.TextXAlignment.Left
errResult.TextYAlignment = Enum.TextYAlignment.Top
errResult.TextWrapped = true
errResult.Text = "Result will appear here..."
errResult.Parent = ef

errorBtn.Click:Connect(function()
	errorWidget.Enabled = not errorWidget.Enabled
end)

fixBtn.MouseButton1Click:Connect(function()
	local errorText = errInput.Text:gsub("^%s+",""):gsub("%s+$","")
	if errorText == "" then
		errResult.Text = "⚠ Paste an error message first!"
		errResult.TextColor3 = STATUS_WARN
		return
	end

	if not authToken then
		errResult.Text = "⚠ Not logged in. Open the LuaForge panel and sign in first."
		errResult.TextColor3 = STATUS_ERR
		return
	end

	fixBtn.Text = "⏳ Asking AI..."
	fixBtn.BackgroundColor3 = BORDER
	errResult.Text = "Sending error to AI..."
	errResult.TextColor3 = MUTED

	local ok, result = pcall(function()
		return HttpService:RequestAsync({
			Url = SERVER_URL .. "/api/explain-error",
			Method = "POST",
			Headers = {
				["Content-Type"] = "application/json",
				["Authorization"] = "Bearer " .. authToken,
			},
			Body = HttpService:JSONEncode({ error = errorText }),
		})
	end)

	fixBtn.Text = "🔴 Explain & Fix This Error"
	fixBtn.BackgroundColor3 = STATUS_ERR

	if ok and result and result.Success then
		local parseOk, data = pcall(function() return HttpService:JSONDecode(result.Body) end)
		if parseOk and data and data.explanation then
			errResult.Text = data.explanation
			errResult.TextColor3 = STATUS_OK
		else
			errResult.Text = "⚠ Could not parse response"
			errResult.TextColor3 = STATUS_ERR
		end
	else
		local errMsg = ok and (result and tostring(result.StatusCode)) or tostring(result)
		errResult.Text = "⚠ Request failed: " .. errMsg .. "\nIs Studio HTTP enabled? (Game Settings → Security)"
		errResult.TextColor3 = STATUS_ERR
	end
end)
