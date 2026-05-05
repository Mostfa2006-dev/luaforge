--[[
  LuaForge Studio Plugin v2 — HTTP Polling
  
  HOW TO INSTALL:
  1. Open Roblox Studio
  2. Plugins tab → Dossier des plugins (Plugins Folder)
  3. Copy this file into that folder
  4. Restart Roblox Studio
  5. Click LuaForge in the Plugins toolbar
]]

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")

-- ═══════════════════════════════════════════════
--  CONFIG
-- ═══════════════════════════════════════════════
local SERVER_URL = "https://luaforge-production-b226.up.railway.app"
local AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI2OWZhNDU5NDZkZGQ0ZWRhZDg2MjM4OWMiLCJpYXQiOjE3NzgwMTcyMzUsImV4cCI6MTc3ODYyMjAzNX0.kWgMo6hUORGw5UhaGmhpuEnjdVgG3iNZyDfYowNBeiU" -- paste your token from localStorage.getItem('lf_token')
local POLL_INTERVAL = 3 -- check every 3 seconds

-- ═══════════════════════════════════════════════
--  TOOLBAR & WIDGET
-- ═══════════════════════════════════════════════
local toolbar = plugin:CreateToolbar("LuaForge")

local toggleBtn = toolbar:CreateButton(
	"LuaForge",
	"Open LuaForge Panel",
	""
)

local widgetInfo = DockWidgetPluginGuiInfo.new(
	Enum.InitialDockState.Right,
	false,
	false,
	300,
	280,
	200,
	180
)

local widget = plugin:CreateDockWidgetPluginGui("LuaForgeWidget", widgetInfo)
widget.Title = "LuaForge"

-- ═══════════════════════════════════════════════
--  UI
-- ═══════════════════════════════════════════════
local frame = Instance.new("Frame")
frame.Size = UDim2.new(1, 0, 1, 0)
frame.BackgroundColor3 = Color3.fromRGB(13, 16, 23)
frame.BorderSizePixel = 0
frame.Parent = widget

local uiPadding = Instance.new("UIPadding")
uiPadding.PaddingLeft = UDim.new(0, 12)
uiPadding.PaddingRight = UDim.new(0, 12)
uiPadding.PaddingTop = UDim.new(0, 12)
uiPadding.Parent = frame

local titleLabel = Instance.new("TextLabel")
titleLabel.Size = UDim2.new(1, 0, 0, 24)
titleLabel.Position = UDim2.new(0, 0, 0, 0)
titleLabel.BackgroundTransparency = 1
titleLabel.TextColor3 = Color3.fromRGB(0, 229, 255)
titleLabel.TextXAlignment = Enum.TextXAlignment.Left
titleLabel.Font = Enum.Font.GothamBold
titleLabel.TextSize = 15
titleLabel.Text = "LUAFORGE"
titleLabel.Parent = frame

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, 0, 0, 20)
statusLabel.Position = UDim2.new(0, 0, 0, 32)
statusLabel.BackgroundTransparency = 1
statusLabel.TextColor3 = Color3.fromRGB(107, 114, 128)
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Font = Enum.Font.Code
statusLabel.TextSize = 11
statusLabel.Text = "○ Connecting..."
statusLabel.Parent = frame

local divider = Instance.new("Frame")
divider.Size = UDim2.new(1, 0, 0, 1)
divider.Position = UDim2.new(0, 0, 0, 60)
divider.BackgroundColor3 = Color3.fromRGB(42, 47, 62)
divider.BorderSizePixel = 0
divider.Parent = frame

local infoLabel = Instance.new("TextLabel")
infoLabel.Size = UDim2.new(1, 0, 0, 80)
infoLabel.Position = UDim2.new(0, 0, 0, 70)
infoLabel.BackgroundTransparency = 1
infoLabel.TextColor3 = Color3.fromRGB(136, 146, 164)
infoLabel.TextXAlignment = Enum.TextXAlignment.Left
infoLabel.TextYAlignment = Enum.TextYAlignment.Top
infoLabel.Font = Enum.Font.Code
infoLabel.TextSize = 11
infoLabel.TextWrapped = true
infoLabel.Text = "Generate a script on rluaforge.netlify.app and click '→ Studio'. It will appear here automatically."
infoLabel.Parent = frame

local logLabel = Instance.new("TextLabel")
logLabel.Size = UDim2.new(1, 0, 0, 50)
logLabel.Position = UDim2.new(0, 0, 0, 160)
logLabel.BackgroundTransparency = 1
logLabel.TextColor3 = Color3.fromRGB(16, 185, 129)
logLabel.TextXAlignment = Enum.TextXAlignment.Left
logLabel.TextYAlignment = Enum.TextYAlignment.Top
logLabel.Font = Enum.Font.Code
logLabel.TextSize = 11
logLabel.TextWrapped = true
logLabel.Text = ""
logLabel.Parent = frame

-- ═══════════════════════════════════════════════
--  HELPERS
-- ═══════════════════════════════════════════════
local function setStatus(msg, color)
	statusLabel.Text = msg
	statusLabel.TextColor3 = color or Color3.fromRGB(107, 114, 128)
end

local function setLog(msg)
	logLabel.Text = msg
end

local function injectScript(code, scriptName, scriptType)
	local instanceType = scriptType or "Script"
	local newScript

	if instanceType == "LocalScript" then
		newScript = Instance.new("LocalScript")
	elseif instanceType == "ModuleScript" then
		newScript = Instance.new("ModuleScript")
	else
		newScript = Instance.new("Script")
	end

	newScript.Name = scriptName or "LuaForgeScript"
	newScript.Source = code

	local target = Selection:Get()[1]
	if target then
		newScript.Parent = target
	else
		if instanceType == "LocalScript" then
			newScript.Parent = game:GetService("StarterPlayerScripts")
		elseif instanceType == "ModuleScript" then
			newScript.Parent = game:GetService("ReplicatedStorage")
		else
			newScript.Parent = game:GetService("ServerScriptService")
		end
	end

	Selection:Set({newScript})
	setLog("✓ Injected: " .. newScript.Name .. "\n" .. os.date("%H:%M:%S"))
	print("[LuaForge] Script injected: " .. newScript.Name)

	-- Tell server we received it so it clears the queue
	pcall(function()
		HttpService:RequestAsync({
			Url = SERVER_URL .. "/api/studio/ack",
			Method = "POST",
			Headers = {
				["Authorization"] = "Bearer " .. AUTH_TOKEN,
				["Content-Type"] = "application/json",
			},
			Body = "{}",
		})
	end)
end

-- ═══════════════════════════════════════════════
--  HTTP POLLING
-- ═══════════════════════════════════════════════
local isPolling = false
local lastScriptId = nil

local function poll()
	if not isPolling then return end
	if not AUTH_TOKEN or AUTH_TOKEN == "" or AUTH_TOKEN == "PASTE_YOUR_TOKEN_HERE" then
		setStatus("⚠ No token set — edit plugin config", Color3.fromRGB(251, 191, 36))
		return
	end

	local ok, result = pcall(function()
		return HttpService:RequestAsync({
			Url = SERVER_URL .. "/api/studio/poll",
			Method = "GET",
			Headers = {
				["Authorization"] = "Bearer " .. AUTH_TOKEN,
				["Content-Type"] = "application/json",
			},
		})
	end)

	if not ok then
		setStatus("✗ Cannot reach server", Color3.fromRGB(248, 113, 113))
		return
	end

	if result.StatusCode == 401 then
		setStatus("✗ Token expired — refresh it", Color3.fromRGB(248, 113, 113))
		isPolling = false
		return
	end

	if result.StatusCode == 200 then
		setStatus("● Connected", Color3.fromRGB(16, 185, 129))
		local parseOk, data = pcall(function()
			return HttpService:JSONDecode(result.Body)
		end)
		if parseOk and data and data.script then
			-- New script available!
			if data.script.id ~= lastScriptId then
				lastScriptId = data.script.id
				injectScript(data.script.code, data.script.name, data.script.scriptType)
			end
		end
	end
end

local function startPolling()
	isPolling = true
	setStatus("○ Connecting...", Color3.fromRGB(107, 114, 128))

	-- Check if HTTP is enabled
	local httpEnabled = pcall(function()
		HttpService:RequestAsync({ Url = SERVER_URL .. "/health", Method = "GET" })
	end)

	if not httpEnabled then
		setStatus("⚠ Enable HTTP in Game Settings!", Color3.fromRGB(251, 191, 36))
		setLog("Go to: Home → Game Settings → Security → Allow HTTP Requests ✓")
		return
	end

	while isPolling do
		poll()
		task.wait(POLL_INTERVAL)
	end
end

local function stopPolling()
	isPolling = false
	setStatus("○ Disconnected", Color3.fromRGB(107, 114, 128))
end

-- ═══════════════════════════════════════════════
--  TOOLBAR BUTTON
-- ═══════════════════════════════════════════════
toggleBtn.Click:Connect(function()
	widget.Enabled = not widget.Enabled
	if widget.Enabled then
		task.spawn(startPolling)
	else
		stopPolling()
	end
end)

-- Auto start when plugin loads
task.spawn(startPolling)
