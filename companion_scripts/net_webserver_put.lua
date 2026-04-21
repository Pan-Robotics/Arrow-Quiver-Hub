--[[
   ArduPilot net_webserver with HTTP PUT support for OTA firmware upload.
   
   Based on the official ArduPilot net_webserver.lua applet with the following
   additions:
   
   1. HTTP PUT method support for uploading files to the FC's SD card
   2. Restricted to /APM/ directory only (for firmware OTA: ardupilot.abin)
   3. Content-Length required for PUT requests
   4. Chunked receive with progress logging via GCS
   
   DEPLOYMENT:
   - Copy this file to the FC's SD card: APM/scripts/net_webserver_put.lua
   - Disable the stock net_webserver.lua if present (rename to .bak)
   - Set SCR_ENABLE=1 and WEB_ENABLE=1, then reboot
   
   USAGE (from companion Pi):
     curl -X PUT --data-binary @ardupilot.abin \
       http://192.168.144.11:8080/APM/ardupilot.abin
   
   The companion script uses requests.put() for the same effect.
   
   SECURITY:
   - Only PUT to paths starting with /APM/ is allowed
   - Maximum upload size: 16 MB (configurable via WEB_MAX_UPLOAD)
   - All other methods besides GET and PUT are rejected
--]]
---@diagnostic disable: param-type-mismatch
---@diagnostic disable: undefined-field
---@diagnostic disable: need-check-nil
---@diagnostic disable: redundant-parameter

local MAV_SEVERITY = {EMERGENCY=0, ALERT=1, CRITICAL=2, ERROR=3, WARNING=4, NOTICE=5, INFO=6, DEBUG=7}

PARAM_TABLE_KEY = 47
PARAM_TABLE_PREFIX = "WEB_"

-- add a parameter and bind it to a variable
function bind_add_param(name, idx, default_value)
    assert(param:add_param(PARAM_TABLE_KEY, idx, name, default_value), string.format('could not add param %s', name))
    return Parameter(PARAM_TABLE_PREFIX .. name)
end

-- Setup Parameters
assert(param:add_table(PARAM_TABLE_KEY, PARAM_TABLE_PREFIX, 8), 'net_webserver_put: could not add param table')

--[[
  // @Param: WEB_ENABLE
  // @DisplayName: enable web server
  // @Description: enable web server
  // @Values: 0:Disabled,1:Enabled
  // @User: Standard
--]]
local WEB_ENABLE = bind_add_param('ENABLE',  1, 1)

--[[
  // @Param: WEB_BIND_PORT
  // @DisplayName: web server TCP port
  // @Description: web server TCP port
  // @Range: 1 65535
  // @User: Standard
--]]
local WEB_BIND_PORT = bind_add_param('BIND_PORT', 2, 8080)

--[[
  // @Param: WEB_DEBUG
  // @DisplayName: web server debugging
  // @Description: web server debugging
  // @Values: 0:Disabled,1:Enabled
  // @User: Advanced
--]]
local WEB_DEBUG = bind_add_param('DEBUG', 3, 0)

--[[
  // @Param: WEB_BLOCK_SIZE
  // @DisplayName: web server block size
  // @Description: web server block size for download
  // @Range: 1 65535
  // @User: Advanced
--]]
local WEB_BLOCK_SIZE = bind_add_param('BLOCK_SIZE', 4, 10240)

--[[
  // @Param: WEB_TIMEOUT
  // @DisplayName: web server timeout
  // @Description: timeout for inactive connections
  // @Units: s
  // @Range: 0.1 60
  // @User: Advanced
--]]
local WEB_TIMEOUT = bind_add_param('TIMEOUT', 5, 2.0)

--[[
  // @Param: WEB_SENDFILE_MIN
  // @DisplayName: web server minimum file size for sendfile
  // @Description: sendfile is an offloading mechanism for faster file download. If this is non-zero and the file is larger than this size then sendfile will be used for file download
  // @Range: 0 10000000
  // @User: Advanced
--]]
local WEB_SENDFILE_MIN = bind_add_param('SENDFILE_MIN', 6, 100000)

--[[
  // @Param: WEB_MAX_UPLOAD
  // @DisplayName: maximum upload file size in bytes
  // @Description: maximum file size for HTTP PUT uploads (0 = 16MB default)
  // @Range: 0 16777216
  // @User: Advanced
--]]
local WEB_MAX_UPLOAD = bind_add_param('MAX_UPLOAD', 7, 16777216)

--[[
  // @Param: WEB_PUT_ENABLE
  // @DisplayName: enable HTTP PUT uploads
  // @Description: enable HTTP PUT method for file uploads to /APM/ directory
  // @Values: 0:Disabled,1:Enabled
  // @User: Standard
--]]
local WEB_PUT_ENABLE = bind_add_param('PUT_ENABLE', 8, 1)

if WEB_ENABLE:get() ~= 1 then
   gcs:send_text(MAV_SEVERITY.INFO, "WebServer: disabled")
   return
end

local BRD_RTC_TZ_MIN = Parameter("BRD_RTC_TZ_MIN")

gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer+PUT: starting on port %u", WEB_BIND_PORT:get()))

local sock_listen = Socket(0)
local clients = {}

local DOCTYPE = "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 3.2 Final//EN\">"
local SERVER_VERSION = "net_webserver_put 1.1"
local CONTENT_TEXT_HTML = "text/html;charset=UTF-8"
local CONTENT_OCTET_STREAM = "application/octet-stream"

local HIDDEN_FOLDERS = { "@SYS", "@ROMFS", "@MISSION", "@PARAM" }

local MNT_PREFIX = "/mnt"
local MNT_PREFIX2 = MNT_PREFIX .. "/"

-- Allowed upload path prefix (security restriction)
local UPLOAD_PATH_PREFIX = "/APM/"

local MIME_TYPES = {
   ["apj"]  = CONTENT_OCTET_STREAM,
   ["abin"] = CONTENT_OCTET_STREAM,
   ["bmp"]  = "image/bmp",
   ["css"]  = "text/css",
   ["csv"]  = "text/csv",
   ["gif"]  = "image/gif",
   ["htm"]  = CONTENT_TEXT_HTML,
   ["html"] = CONTENT_TEXT_HTML,
   ["ico"]  = "image/x-icon",
   ["jpeg"] = "image/jpeg",
   ["jpg"]  = "image/jpeg",
   ["js"]   = "text/javascript",
   ["json"] = "application/json",
   ["lua"]  = "text/x-lua",
   ["mp4"]  = "video/mp4",
   ["otf"]  = "font/otf",
   ["png"]  = "image/png",
   ["pdf"]  = "application/pdf",
   ["php"]  = "application/x-httpd-php",
   ["ppt"]  = "application/vnd.ms-powerpoint",
   ["pptx"] = "application/vnd.openxmlformats-officedocument.presentationml.presentation",
   ["rar"]  = "application/vnd.rar",
   ["svg"]  = "image/svg+xml",
   ["tar"]  = "application/x-tar",
   ["tif"]  = "image/tiff",
   ["tiff"] = "image/tiff",
   ["ttf"]  = "font/ttf",
   ["txt"]  = "text/plain",
   ["wav"]  = "audio/wav",
   ["woff"] = "font/woff",
   ["woff2"]= "font/woff2",
   ["xhtml"]= "application/xhtml+xml",
   ["xls"]  = "application/vnd.ms-excel",
   ["xlsx"] = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
   ["xml"]  = "application/xml",
   ["zip"]  = "application/zip",
   ["bin"]  = CONTENT_OCTET_STREAM,
   ["dat"]  = CONTENT_OCTET_STREAM,
   ["shtml"]= CONTENT_TEXT_HTML,
}

local DYNAMIC_PAGES = {}

local function startswith(s, prefix)
   return string.sub(s, 1, #prefix) == prefix
end

local function endswith(s, suffix)
   return string.sub(s, -#suffix) == suffix
end

local function split(str, pattern)
   local result = {}
   for s in string.gmatch(str, pattern) do
      table.insert(result, s)
   end
   return result
end

function DEBUG(txt)
   if WEB_DEBUG:get() ~= 0 then
      gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer: %s", txt))
   end
end

local function isdirectory(path)
   local s = fs:stat(path)
   if not s then
      return false
   end
   return s:is_directory()
end

local function file_exists(path)
   local s = fs:stat(path)
   return s ~= nil
end

local function is_hidden_dir(path)
   for _,v in ipairs(HIDDEN_FOLDERS) do
      if startswith(path, "/" .. v) or startswith(path, v) then
         return true
      end
   end
   return false
end

local function file_timestring(path)
   local s = fs:stat(path)
   if not s then
      return ""
   end
   local mtime = s:mtime()
   mtime = mtime + BRD_RTC_TZ_MIN:get()*60
   local year, month, day, hour, min, sec = rtc:clock_s_to_date_fields(mtime)
   return string.format("%04u-%02u-%02u %02u:%02u:%02u", year, month, day, hour, min, sec)
end

local function file_timestring_http(mtime)
   local year, month, day, hour, min, sec, wday = rtc:clock_s_to_date_fields(mtime)
   if not year then
      return nil
   end
   local daynames = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" }
   local monthnames = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }
   return string.format("%s, %02u %s %04u %02u:%02u:%02u GMT", daynames[wday+1], day, monthnames[month], year, hour, min, sec)
end

local function file_timestring_http_parse(s)
   local daynames = { "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" }
   local monthnames = { "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" }
   local _, day, monthstr, year, hour, min, sec = string.match(s, "(%a+), (%d+) (%a+) (%d+) (%d+):(%d+):(%d+) GMT")
   if not day then
      return nil
   end
   local month = nil
   for i,v in ipairs(monthnames) do
      if v == monthstr then
         month = i
         break
      end
   end
   if not month then
      return nil
   end
   return rtc:date_fields_to_clock_s(tonumber(year), tonumber(month), tonumber(day), tonumber(hour), tonumber(min), tonumber(sec))
end

local function substitute_vars(s, vars)
   return string.gsub(s, "{(%w+)}", function(k) return vars[k] or "" end)
end

--[[
   client class for open connections
--]]
local function Client(sock, idx)
   local self = {}
   self.closed = false

   local have_header = false
   local header = ""
   local header_lines = {}
   local header_vars = {}
   local run = nil
   local protocol = nil
   local file = nil
   local start_time = millis()
   local offset = 0
   
   -- PUT upload state
   local put_file = nil
   local put_remaining = 0
   local put_received = 0
   local put_body_leftover = nil

   function self.read_header()
      local s = sock:recv(2048)
      if not s then
         local now = millis()
         if not sock:is_connected() or now - start_time > WEB_TIMEOUT:get()*1000 then
            -- EOF while looking for header
            DEBUG(string.format("%u: EOF", idx))
            self.remove()
            return false
         end
         return false
      end
      if not s or #s == 0 then
         return false
      end
      header = header .. s
      local eoh = string.find(header, '\r\n\r\n')
      if eoh then
         DEBUG(string.format("%u: got header", idx))
         have_header = true
         -- Split header from any body data that arrived in the same recv
         local header_part = string.sub(header, 1, eoh + 3)
         put_body_leftover = string.sub(header, eoh + 4)
         header_lines = split(header_part, "[^\r\n]+")
         -- blocking for reply
         sock:set_blocking(true)
         return true
      end
      return false
   end

   function self.sendstring(s)
      sock:send(s, #s)
   end

   function self.sendline(s)
      self.sendstring(s .. "\r\n")
   end

   --[[
      send a string with variable substitution using {varname}
   --]]
   function self.sendstring_vars(s, vars)
      self.sendstring(substitute_vars(s, vars))
   end
   
   function self.send_header(code, codestr, vars)
      self.sendline(string.format("%s %u %s", protocol, code, codestr))
      self.sendline(string.format("Server: %s", SERVER_VERSION))
      for k,v in pairs(vars) do
         self.sendline(string.format("%s: %s", k, v))
      end
      self.sendline("Connection: close")
      self.sendline("")
   end

   -- get size of a file
   function self.file_size(fname)
      local s = fs:stat(fname)
      if not s then
         return 0
      end
      local ret = s:size():toint()
      DEBUG(string.format("%u: size of '%s' -> %u", idx, fname, ret))
      return ret
   end


   --[[
      return full path with .. resolution
   --]]
   function self.full_path(path, name)
      DEBUG(string.format("%u: full_path(%s,%s)", idx, path, name))
      local ret
      if path == "/" then
         ret = "/" .. name
      else
         ret = path .. "/" .. name
      end
      -- on ChibiOS we don't get ..
      while true do
         local m = string.match(ret, "(.*)/[^/]+/%.%.")
         if not m then
            break
         end
         ret = m
         if ret == "" then
            ret = "/"
         end
      end
      return ret
   end

   --[[
      directory listing
   --]]
   function self.directory_list(path)
      DEBUG(string.format("%u: directory_list(%s)", idx, path))
      local dlist = dirlist(path)
      if not dlist then
         self.not_found(path)
         return
      end
      if path == "/" then
         for _,v in ipairs(HIDDEN_FOLDERS) do
            table.insert(dlist, v)
         end
      end

      table.sort(dlist)
      self.send_header(200, "OK", {["Content-Type"]=CONTENT_TEXT_HTML})
      self.sendline(DOCTYPE)
      self.sendstring_vars([[
<html>
 <head>
  <title>Index of {path}</title>
 </head>
 <body>
<h1>Index of {path}</h1>
  <table>
   <tr><th align="left">Name</th><th align="left">Last modified</th><th align="left">Size</th></tr>
]], {path=path})
      for _,d in ipairs(dlist) do
         local skip = d == "."
         if not skip then
            local fullpath = self.full_path(path, d)
            local name = d
            local sizestr = "0"
            local stat = fs:stat(fullpath)
            local size = stat and stat:size() or 0
            if is_hidden_dir(fullpath) or (stat and stat:is_directory()) then
               name = name .. "/"
            elseif size >= 100*1000*1000 then
               sizestr = string.format("%uM", (size/(1000*1000)):toint())
            else
               sizestr = tostring(size)
            end
            local modtime = file_timestring(fullpath)
            self.sendstring_vars([[<tr><td align="left"><a href="{name}">{name}</a></td><td align="left">{modtime}</td><td align="left">{size}</td></tr>
]], { name=name, size=sizestr, modtime=modtime })
         end
      end
      self.sendstring([[
</table>
</body>
</html>
]])
   end

   -- send file content
   function self.send_file()
      if not sock:pollout(0) then
         return
      end
      local chunk = WEB_BLOCK_SIZE:get()
      local b = file:read(chunk)
      sock:set_blocking(true)
      if b and #b > 0 then
         local sent = sock:send(b, #b)
         if sent == -1 then
            run = nil
            self.remove()
            return
         end
         if sent < #b then
            file:seek(offset+sent)
         end
         offset = offset + sent
      end
      if not b or #b < chunk then
         -- EOF
         DEBUG(string.format("%u: sent file", idx))
         run = nil
         self.remove()
         return
      end
   end

   --[[
      load whole file as a string
   --]]
   function self.load_file()
      local chunk = WEB_BLOCK_SIZE:get()
      local ret = ""
      while true do
         local b = file:read(chunk)
         if not b or #b == 0 then
            break
         end
         ret = ret .. b
      end
      return ret
   end
   
   --[[
      evaluate some lua code and return as a string
   --]]
   function self.evaluate(code)
      local eval_code = "function eval_func()\n" .. code .. "\nend\n"
      local f, errloc, err = load(eval_code, "eval_func", "t", _ENV)
      if not f then
         DEBUG(string.format("load failed: err=%s errloc=%s", err, errloc))
         return nil
      end
      f()
      local ok, s = pcall(eval_func)
      if ok and s then
         return s
      end
      return nil
   end

   --[[
      send a CGI file
   --]]
   function self.send_cgi()
      local contents = self.load_file()
      local s = self.evaluate(contents)
      if s then
         self.sendstring(s)
      end
      self.remove()
   end

   --[[
      send a processed file, expanding server side includes
   --]]
   function self.send_processed_file(dynamic_page)
      local contents
      if dynamic_page then
         contents = file
      else
         contents = self.load_file()
      end
      while #contents > 0 do
         local pat1 = "(.-)[<][?]lua[ \n](.-)[?][>](.*)"
         local pat2 = "(.-)[<][?]lstr[ \n](.-)[?][>](.*)"
         local p1, p2, p3 = string.match(contents, pat1)
         if not p1 then
            p1, p2, p3 = string.match(contents, pat2)
            if not p1 then
               break
            end
            p2 = "return tostring(" .. p2 .. ")"
         end
         self.sendstring(p1)
         local s2 = self.evaluate(p2)
         if s2 then
            self.sendstring(s2)
         end
         contents = p3
      end
      self.sendstring(contents)
      self.remove()
   end
   
   -- return a content type
   function self.content_type(path)
      if path == "/" then
         return MIME_TYPES["html"]
      end
      local _, ext = string.match(path, '(.*[.])(.*)')
      ext = string.lower(ext)
      local ret = MIME_TYPES[ext]
      if not ret then
         return CONTENT_OCTET_STREAM
      end
      return ret
   end

   -- perform a file download
   function self.file_download(path)
      if startswith(path, "/@") then
         path = string.sub(path, 2, #path)
      end
      DEBUG(string.format("%u: file_download(%s)", idx, path))
      file = DYNAMIC_PAGES[path]
      dynamic_page = file ~= nil
      if not dynamic_page then
         file = io.open(path,"rb")
         if not file then
            DEBUG(string.format("%u: Failed to open '%s'", idx, path))
            return false
         end
      end
      local vars = {["Content-Type"]=self.content_type(path)}
      local cgi_processing = startswith(path, "/cgi-bin/") and endswith(path, ".lua")
      local server_side_processing = endswith(path, ".shtml")
      local stat = fs:stat(path)
      if not startswith(path, "@") and
         not server_side_processing and
         not cgi_processing and stat and
         not dynamic_page then
         local fsize = stat:size()
         local mtime = stat:mtime()
         vars["Content-Length"]= tostring(fsize)
         local modtime = file_timestring_http(mtime)
         if modtime then
            vars["Last-Modified"] = modtime
         end
         local if_modified_since = header_vars['If-Modified-Since']
         if if_modified_since then
            local tsec = file_timestring_http_parse(if_modified_since)
            if tsec and tsec >= mtime then
               DEBUG(string.format("%u: Not modified: %s %s", idx, modtime, if_modified_since))
               self.send_header(304, "Not Modified", vars)
               return true
            end
         end
      end
      self.send_header(200, "OK", vars)
      if server_side_processing or dynamic_page then
         DEBUG(string.format("%u: shtml processing %s", idx, path))
         run = self.send_processed_file(dynamic_page)
      elseif cgi_processing then
         DEBUG(string.format("%u: CGI processing %s", idx, path))
         run = self.send_cgi
      elseif stat and
         WEB_SENDFILE_MIN:get() > 0 and
         stat:size() >= WEB_SENDFILE_MIN:get() and
         sock:sendfile(file) then
         return true
      else
         run = self.send_file
      end
      return true
   end

   function self.not_found()
      self.send_header(404, "Not found", {})
   end

   function self.moved_permanently(relpath)
      if not startswith(relpath, "/") then
         relpath = "/" .. relpath
      end
      local location = string.format("http://%s%s", header_vars['Host'], relpath)
      DEBUG(string.format("%u: Redirect -> %s", idx, location))
      self.send_header(301, "Moved Permanently", {["Location"]=location})
   end

   -- ═══════════════════════════════════════════════════════════════════
   -- HTTP PUT upload handler
   -- ═══════════════════════════════════════════════════════════════════

   --[[
      Receive file data for PUT request. Called repeatedly from the
      update loop until all bytes are received or an error occurs.
   --]]
   function self.receive_file()
      if put_remaining <= 0 then
         -- All data received
         if put_file then
            put_file:close()
            put_file = nil
         end
         gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer: PUT complete, %u bytes received", put_received))
         self.send_header(201, "Created", {
            ["Content-Type"] = "text/plain",
            ["Content-Length"] = tostring(#"OK")
         })
         self.sendstring("OK")
         run = nil
         self.remove()
         return
      end

      -- Read a chunk from the socket
      local chunk_size = math.min(put_remaining, WEB_BLOCK_SIZE:get())
      local data = sock:recv(chunk_size)
      if not data then
         local now = millis()
         -- Use a longer timeout for uploads (60 seconds)
         if not sock:is_connected() or now - start_time > 60000 then
            gcs:send_text(MAV_SEVERITY.ERROR, string.format("WebServer: PUT timeout after %u bytes", put_received))
            if put_file then
               put_file:close()
               put_file = nil
            end
            run = nil
            self.remove()
         end
         return
      end
      if #data > 0 then
         put_file:write(data)
         put_file:flush()
         put_remaining = put_remaining - #data
         put_received = put_received + #data
         -- Reset timeout on data receipt
         start_time = millis()
         -- Log progress every 100KB
         if put_received % 102400 < #data then
            gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer: PUT %uKB received", put_received / 1024))
         end
      end
   end

   --[[
      Handle a PUT request. Validates the path, opens the file, and
      starts the receive loop.
   --]]
   function self.handle_put(path)
      -- Security: only allow PUT to /APM/ directory
      if not startswith(path, UPLOAD_PATH_PREFIX) then
         gcs:send_text(MAV_SEVERITY.WARNING, string.format("WebServer: PUT rejected, path not in /APM/: %s", path))
         self.send_header(403, "Forbidden", {["Content-Type"]="text/plain"})
         self.sendstring("PUT only allowed to /APM/ directory")
         self.remove()
         return
      end

      -- Check if PUT is enabled
      if WEB_PUT_ENABLE:get() ~= 1 then
         gcs:send_text(MAV_SEVERITY.WARNING, "WebServer: PUT rejected, WEB_PUT_ENABLE=0")
         self.send_header(403, "Forbidden", {["Content-Type"]="text/plain"})
         self.sendstring("PUT uploads disabled (set WEB_PUT_ENABLE=1)")
         self.remove()
         return
      end

      -- Require Content-Length header
      local content_length = header_vars['Content-Length']
      if not content_length then
         self.send_header(411, "Length Required", {["Content-Type"]="text/plain"})
         self.sendstring("Content-Length header required for PUT")
         self.remove()
         return
      end

      local file_size = tonumber(content_length)
      if not file_size or file_size <= 0 then
         self.send_header(400, "Bad Request", {["Content-Type"]="text/plain"})
         self.sendstring("Invalid Content-Length")
         self.remove()
         return
      end

      -- Check max upload size
      local max_size = WEB_MAX_UPLOAD:get()
      if max_size > 0 and file_size > max_size then
         gcs:send_text(MAV_SEVERITY.WARNING, string.format("WebServer: PUT rejected, %u bytes exceeds max %u", file_size, max_size))
         self.send_header(413, "Payload Too Large", {["Content-Type"]="text/plain"})
         self.sendstring(string.format("File too large: %u bytes (max %u)", file_size, max_size))
         self.remove()
         return
      end

      -- Security: prevent path traversal
      if string.find(path, "%.%.") then
         self.send_header(400, "Bad Request", {["Content-Type"]="text/plain"})
         self.sendstring("Path traversal not allowed")
         self.remove()
         return
      end

      gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer: PUT %s (%u bytes)", path, file_size))

      -- Open file for writing (binary mode)
      put_file = io.open(path, "wb")
      if not put_file then
         gcs:send_text(MAV_SEVERITY.ERROR, string.format("WebServer: PUT failed to open %s for writing", path))
         self.send_header(500, "Internal Server Error", {["Content-Type"]="text/plain"})
         self.sendstring("Failed to open file for writing")
         self.remove()
         return
      end

      put_remaining = file_size
      put_received = 0

      -- Write any body data that arrived with the header
      if put_body_leftover and #put_body_leftover > 0 then
         put_file:write(put_body_leftover)
         put_file:flush()
         put_remaining = put_remaining - #put_body_leftover
         put_received = put_received + #put_body_leftover
         put_body_leftover = nil
      end

      -- Set the run function to continue receiving
      run = self.receive_file
   end

   -- ═══════════════════════════════════════════════════════════════════
   -- Request processing (GET + PUT)
   -- ═══════════════════════════════════════════════════════════════════

   -- process a single request
   function self.process_request()
      local h1 = header_lines[1]
      if not h1 or #h1 == 0 then
         DEBUG(string.format("%u: empty request", idx))
         return
      end
      local cmd = split(header_lines[1], "%S+")
      if not cmd or #cmd < 3 then
         DEBUG(string.format("bad request: %s", header_lines[1]))
         return
      end
      local method = cmd[1]
      if method ~= "GET" and method ~= "PUT" then
         DEBUG(string.format("bad op: %s", method))
         self.send_header(405, "Method Not Allowed", {["Content-Type"]="text/plain", ["Allow"]="GET, PUT"})
         self.sendstring("Only GET and PUT methods are supported")
         self.remove()
         return
      end
      protocol = cmd[3]
      if protocol ~= "HTTP/1.0" and protocol ~= "HTTP/1.1" then
         DEBUG(string.format("bad protocol: %s", protocol))
         return
      end
      local path = cmd[2]
      DEBUG(string.format("%u: %s path='%s'", idx, method, path))

      -- extract header variables
      for i = 2,#header_lines do
         local key, var = string.match(header_lines[i], '(.*): (.*)')
         if key then
            header_vars[key] = var
         end
      end

      -- Route PUT requests to the upload handler
      if method == "PUT" then
         self.handle_put(path)
         return
      end

      -- === GET request handling (unchanged from stock net_webserver.lua) ===

      if DYNAMIC_PAGES[path] ~= nil then
         self.file_download(path)
         return
      end

      if path == MNT_PREFIX then
         path = "/"
      end
      if startswith(path, MNT_PREFIX2) then
         path = string.sub(path,#MNT_PREFIX2,#path)
      end

      if isdirectory(path) and
         not endswith(path,"/") and
         header_vars['Host'] and
         not is_hidden_dir(path) then
         self.moved_permanently(path .. "/")
         return
      end

      if path ~= "/" and endswith(path,"/") then
         path = string.sub(path, 1, #path-1)
      end

      if startswith(path,"/@") then
         path = string.sub(path, 2, #path)
      end

      -- see if we have an index file
      if isdirectory(path) and file_exists(path .. "/index.html") then
         DEBUG(string.format("%u: found index.html", idx))
         if self.file_download(path .. "/index.html") then
            return
         end
      end
      
      -- see if it is a directory
      if (path == "/" or
         DYNAMIC_PAGES[path] == nil) and
         (endswith(path,"/") or
          isdirectory(path) or
          is_hidden_dir(path)) then
         self.directory_list(path)
         return
      end
      
      -- or a file
      if self.file_download(path) then
         return
      end
      self.not_found(path)
   end

   -- update the client
   function self.update()
      if run then
         run()
         return
      end
      if not have_header then
         if not self.read_header() then
            return
         end
      end
      self.process_request()
      if not run then
         -- nothing more to do
         self.remove()
      end
   end

   function self.remove()
      DEBUG(string.format("%u: removing client OFFSET=%u", idx, offset))
      if put_file then
         put_file:close()
         put_file = nil
      end
      if sock then
         sock:close()
         sock = nil
      end
      self.closed = true
   end

   -- return the instance
   return self
end

--[[
   see if any new clients want to connect
--]]
local function check_new_clients()
   while sock_listen:pollin(0) do
      local sock = sock_listen:accept()
      if not sock then
         return
      end
      -- non-blocking for header read
      sock:set_blocking(false)
      -- find free client slot
      for i = 1, #clients+1 do
         if clients[i] == nil then
            local idx = i
            local client = Client(sock, idx)
            DEBUG(string.format("%u: New client", idx))
            clients[idx] = client
         end
      end
   end
end

--[[
   check for client activity
--]]
local function check_clients()
   for idx,client in ipairs(clients) do
      if not client.closed then
         client.update()
      end
      if client.closed then
         table.remove(clients,idx)
      end
   end
end

if not sock_listen:bind("0.0.0.0", WEB_BIND_PORT:get()) then
   gcs:send_text(MAV_SEVERITY.ERROR, string.format("WebServer: failed to bind to TCP %u", WEB_BIND_PORT:get()))
   return
end

if not sock_listen:listen(20) then
   gcs:send_text(MAV_SEVERITY.ERROR, "WebServer: failed to listen")
   return
end

gcs:send_text(MAV_SEVERITY.INFO, string.format("WebServer+PUT: ready on port %u (PUT to /APM/ enabled)", WEB_BIND_PORT:get()))

local function update()
   check_new_clients()
   check_clients()
   return update,5
end

return update,100
