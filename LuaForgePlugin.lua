--[[
  LuaForge Studio Plugin
  
  HOW TO INSTALL:
  1. Open Roblox Studio
  2. Go to View → Plugin Manager → Create Plugin
  3. Paste this entire script as the plugin source
  4. Or: create a Script in ServerScriptService named "LuaForgePlugin",
     paste this in, then publish to Plugin folder
  
  The plugin will:
  - Add a toolbar button "LuaForge"
  - Connect to your Railway server via WebSocket
  - Inject generated scripts directly into Explorer
]]

local HttpService = game:GetService("HttpService")
local StudioService = game:GetService("StudioService")
local Selection = game:GetService("Selection")
local RunService = game:GetService("RunService")

-- ═══════════════════════════════════════════════
--  CONFIG — match your Railway URL
-- ═══════════════════════════════════════════════
local SERVER_WS_URL = "wss://YOUR-APP.up.railway.app" -- ← CHANGE THIS
local AUTH_TOKEN = "" -- Paste your JWT token here, OR load from plugin settings

-- ═══════════════════════════════════════════════
--  TOOLBAR & WIDGET
-- ═══════════════════════════════════════════════
local toolbar = plugin:CreateToolbar("LuaForge")

local connectBtn = toolbar:CreateButton(
    "LuaForge",
    "Connect to LuaForge AI",
    "" -- Add icon asset ID here if desired
)

local widgetInfo = DockWidgetPluginGuiInfo.new(
    Enum.InitialDockState.Right,
    false,
    false,
    300,
    200,
    200,
    150
)

local widget = plugin:CreateDockWidgetPluginGui("LuaForgeWidget", widgetInfo)
widget.Title = "LuaForge"

-- Simple status UI
local frame = Instance.new("Frame")
frame.Size = UDim2.new(1, 0, 1, 0)
frame.BackgroundColor3 = Color3.fromRGB(13, 16, 23)
frame.BorderSizePixel = 0
frame.Parent = widget

local statusLabel = Instance.new("TextLabel")
statusLabel.Size = UDim2.new(1, -20, 0, 30)
statusLabel.Position = UDim2.new(0, 10, 0, 10)
statusLabel.BackgroundTransparency = 1
statusLabel.TextColor3 = Color3.fromRGB(0, 229, 255)
statusLabel.TextXAlignment = Enum.TextXAlignment.Left
statusLabel.Font = Enum.Font.Code
statusLabel.TextSize = 13
statusLabel.Text = "● Disconnected"
statusLabel.Parent = frame

local infoLabel = Instance.new("TextLabel")
infoLabel.Size = UDim2.new(1, -20, 0, 100)
infoLabel.Position = UDim2.new(0, 10, 0, 50)
infoLabel.BackgroundTransparency = 1
infoLabel.TextColor3 = Color3.fromRGB(136, 146, 164)
infoLabel.TextXAlignment = Enum.TextXAlignment.Left
infoLabel.TextYAlignment = Enum.TextYAlignment.Top
infoLabel.Font = Enum.Font.Code
infoLabel.TextSize = 11
infoLabel.TextWrapped = true
infoLabel.Text = "Open LuaForge in your browser and generate a script. It will appear here automatically."
infoLabel.Parent = frame

local scriptLog = Instance.new("TextLabel")
scriptLog.Size = UDim2.new(1, -20, 0, 40)
scriptLog.Position = UDim2.new(0, 10, 1, -55)
scriptLog.BackgroundTransparency = 1
scriptLog.TextColor3 = Color3.fromRGB(16, 185, 129)
scriptLog.TextXAlignment = Enum.TextXAlignment.Left
scriptLog.TextYAlignment = Enum.TextYAlignment.Top
scriptLog.Font = Enum.Font.Code
scriptLog.TextSize = 11
scriptLog.TextWrapped = true
scriptLog.Text = ""
scriptLog.Parent = frame

-- ═══════════════════════════════════════════════
--  WEBSOCKET CONNECTION
-- ═══════════════════════════════════════════════
local ws = nil
local connected = false
local reconnectDelay = 5

local function setStatus(msg, color)
    statusLabel.Text = msg
    statusLabel.TextColor3 = color or Color3.fromRGB(0, 229, 255)
end

local function injectScript(code, scriptName)
    -- Create a script in workspace
    local newScript = Instance.new("Script")
    newScript.Name = scriptName or "LuaForgeScript"
    newScript.Source = code
    
    -- Try to put it in a sensible location
    local target = Selection:Get()[1]
    if target then
        newScript.Parent = target
    else
        newScript.Parent = game:GetService("ServerScriptService")
    end
    
    -- Select the new script in explorer
    Selection:Set({newScript})
    
    scriptLog.Text = "✓ Injected: " .. (scriptName or "LuaForgeScript") .. "\n" .. os.date("%H:%M:%S")
    print("[LuaForge] Script injected: " .. (scriptName or "LuaForgeScript"))
end

local function connect()
    if not AUTH_TOKEN or AUTH_TOKEN == "" then
        setStatus("⚠ No auth token set", Color3.fromRGB(251, 191, 36))
        return
    end
    
    setStatus("○ Connecting...", Color3.fromRGB(90, 96, 112))
    
    local success, err = pcall(function()
        ws = HttpService:WebSocketConnect(SERVER_WS_URL .. "?token=" .. HttpService:UrlEncode(AUTH_TOKEN))
    end)
    
    if not success then
        setStatus("✗ Connection failed", Color3.fromRGB(248, 113, 113))
        task.delay(reconnectDelay, connect)
        return
    end
    
    ws.OnMessage:Connect(function(msg)
        local ok, data = pcall(function() return HttpService:JSONDecode(msg) end)
        if not ok then return end
        
        if data.type == "connected" then
            connected = true
            setStatus("● Connected", Color3.fromRGB(16, 185, 129))
            print("[LuaForge] Connected to server as authenticated user")
            
        elseif data.type == "inject_script" then
            setStatus("● Connected · Receiving script...", Color3.fromRGB(0, 229, 255))
            injectScript(data.code, data.scriptName)
            setStatus("● Connected", Color3.fromRGB(16, 185, 129))
            
        elseif data.type == "kicked" then
            setStatus("✗ Kicked by server", Color3.fromRGB(248, 113, 113))
            connected = false
        end
    end)
    
    ws.OnClose:Connect(function()
        connected = false
        setStatus("○ Disconnected · Reconnecting...", Color3.fromRGB(90, 96, 112))
        task.delay(reconnectDelay, connect)
    end)
end

-- ═══════════════════════════════════════════════
--  TOOLBAR BUTTON
-- ═══════════════════════════════════════════════
connectBtn.Click:Connect(function()
    widget.Enabled = not widget.Enabled
    if widget.Enabled and not connected then
        connect()
    end
end)

-- Auto-connect when plugin loads
connect()
