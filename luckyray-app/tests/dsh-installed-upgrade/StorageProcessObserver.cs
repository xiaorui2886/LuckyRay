// Test-only, read-only metadata observer for one synthetic initialize child.
// No debugger attachment, injection, privilege adjustment or stream consumption.
// Windows x64 PEB fields are accepted only after image/command/path validation.
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

class StorageProcessObserver {
  static JavaScriptSerializer Json = new JavaScriptSerializer();
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr reserved1,peb,reserved20,reserved21,pid,reserved3; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Entry {
    public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string name;
  }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot,ref Entry value);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot,ref Entry value);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process,int info,ref Basic result,int size,out int returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process,IntPtr address,byte[] bytes,int size,out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr copy,uint access,bool inherit,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeInfo(IntPtr handle,out uint flags,out uint outputSize,out uint inputSize,out uint instances);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool PeekNamedPipe(IntPtr handle,IntPtr buffer,uint size,IntPtr read,out uint available,IntPtr left);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessIoCounters(IntPtr process,out Io value);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string line,out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  static object sync = new object();
  static void Row(string file,string kind,object data) {
    lock(sync) File.AppendAllText(file,Json.Serialize(new {atUtc=DateTime.UtcNow.ToString("o"),kind=kind,data=data})+"\n",new UTF8Encoding(false));
  }
  static byte[] Read(IntPtr process,long address,int length) {
    if(address<=0 || length<0 || length>32768) throw new Exception("bounded-process-metadata-required");
    var bytes=new byte[length];IntPtr count;
    if(!ReadProcessMemory(process,new IntPtr(address),bytes,length,out count)||count.ToInt64()!=length) throw new Exception("process-metadata-read-failed");
    return bytes;
  }
  static string UString(IntPtr process,byte[] parameters,int offset) {
    int length=BitConverter.ToUInt16(parameters,offset),max=BitConverter.ToUInt16(parameters,offset+2);
    if(length==0 || length%2!=0 || length>max || length>32766) throw new Exception("bounded-unicode-path-required");
    return Encoding.Unicode.GetString(Read(process,BitConverter.ToInt64(parameters,offset+8),length));
  }
  static object Pipe(IntPtr process,long value) {
    IntPtr copy;
    if(value==0 || value==-1) return new {valid=false};
    if(!DuplicateHandle(process,new IntPtr(value),GetCurrentProcess(),out copy,0,false,2)) return new {duplicateError=Marshal.GetLastWin32Error()};
    try {
      uint type=GetFileType(copy),flags,outputSize,inputSize,instances,available;
      bool info=GetNamedPipeInfo(copy,out flags,out outputSize,out inputSize,out instances);int infoError=info?0:Marshal.GetLastWin32Error();
      bool peek=PeekNamedPipe(copy,IntPtr.Zero,0,IntPtr.Zero,out available,IntPtr.Zero);int peekError=peek?0:Marshal.GetLastWin32Error();
      return new {fileType=type,pipeInfoAvailable=info,pipeInfoError=infoError,pipeFlags=info?(uint?)flags:null,peekAvailable=peek,peekError=peekError,queuedBytes=peek?(uint?)available:null,contentRead=false};
    } finally {CloseHandle(copy);}
  }
  static object Snapshot(Process child,string expectedImage) {
    IntPtr handle=OpenProcess(0x0400|0x0010|0x0040,false,child.Id); // query, VM_READ, DUP_HANDLE only
    if(handle==IntPtr.Zero) return new {metadataAvailable=false,error=Marshal.GetLastWin32Error()};
    try {
      Basic basic=new Basic();int returned;
      if(IntPtr.Size!=8 || NtQueryInformationProcess(handle,0,ref basic,Marshal.SizeOf(typeof(Basic)),out returned)!=0) throw new Exception("x64-process-basic-info-unavailable");
      long parametersAddress=BitConverter.ToInt64(Read(handle,basic.peb.ToInt64()+0x20,8),0);
      var parameters=Read(handle,parametersAddress,128);
      string image=UString(handle,parameters,0x60);
      if(!String.Equals(Path.GetFullPath(image),Path.GetFullPath(expectedImage),StringComparison.OrdinalIgnoreCase)) throw new Exception("metadata-layout-image-check-failed");
      string cwd=UString(handle,parameters,0x38);
      if(!Path.IsPathRooted(cwd)||!Directory.Exists(cwd)) throw new Exception("metadata-layout-cwd-check-failed");
      Io io;bool hasIo=GetProcessIoCounters(handle,out io);
      var waits=new Dictionary<string,int>();
      foreach(ProcessThread thread in child.Threads) {
        string state=thread.ThreadState.ToString();if(thread.ThreadState==System.Diagnostics.ThreadState.Wait)state+="/"+thread.WaitReason.ToString();
        if(!waits.ContainsKey(state))waits[state]=0;waits[state]++;
      }
      return new {metadataAvailable=true,workingDirectory=cwd,imageChecked=true,
        stdin=Pipe(handle,BitConverter.ToInt64(parameters,0x20)),stdout=Pipe(handle,BitConverter.ToInt64(parameters,0x28)),stderr=Pipe(handle,BitConverter.ToInt64(parameters,0x30)),
        cpuMs=child.TotalProcessorTime.TotalMilliseconds,workingSetBytes=child.WorkingSet64,threadStates=waits,
        ioCountersAvailable=hasIo,readBytes=io.readBytes,writeBytes=io.writeBytes,otherBytes=io.otherBytes,
        ioCountersAreNotPipeSpecific=true,environmentRead=false,streamContentsRead=false};
    } catch(Exception error) {return new {metadataAvailable=false,reason=error.Message};}
    finally {CloseHandle(handle);}
  }
  static string[] Argv(string command) {
    int count;IntPtr pointer=CommandLineToArgvW(command,out count);if(pointer==IntPtr.Zero)throw new Exception("argv-unavailable");
    try {var values=new string[count];for(int i=0;i<count;i++)values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));return values;}finally{LocalFree(pointer);}
  }
  static string[] SafeArguments(int pid,string image,string helper,string directory) {
    using(var result=new ManagementObjectSearcher("SELECT CommandLine,ExecutablePath FROM Win32_Process WHERE ProcessId="+pid)) {
      foreach(ManagementObject item in result.Get()) {
        if(!String.Equals((string)item["ExecutablePath"],image,StringComparison.OrdinalIgnoreCase))throw new Exception("unexpected-child-image");
        string[] actual=Argv((string)item["CommandLine"]);
        string[] wanted=new[]{image,"-NoProfile","-NonInteractive","-File",helper,"-Directory",directory,"-Action","initialize","-Name","tunnel-key"};
        if(actual.Length!=wanted.Length||actual.Where((v,i)=>!String.Equals(
          new[]{0,4,6}.Contains(i)?Path.GetFullPath(v):v,
          new[]{0,4,6}.Contains(i)?Path.GetFullPath(wanted[i]):wanted[i],StringComparison.OrdinalIgnoreCase)).Any())throw new Exception("non-initialize-arguments-not-recorded");
        return actual;
      }
    }
    throw new Exception("child-commandline-unavailable");
  }
  static string Quote(string text) {
    var result=new StringBuilder("\"");int slashes=0;
    foreach(char ch in text) {if(ch=='\\'){slashes++;continue;}result.Append('\\',ch=='"'?slashes*2+1:slashes);result.Append(ch);slashes=0;}
    result.Append('\\',slashes*2);result.Append('"');return result.ToString();
  }
  static int FindChild(int parent) {
    IntPtr snapshot=CreateToolhelp32Snapshot(2,0);
    if(snapshot==new IntPtr(-1))throw new Exception("process-snapshot-unavailable");
    try {
      var entry=new Entry();entry.size=(uint)Marshal.SizeOf(typeof(Entry));
      bool found=Process32FirstW(snapshot,ref entry);
      while(found){if(entry.parent==(uint)parent&&String.Equals(entry.name,"powershell.exe",StringComparison.OrdinalIgnoreCase))return (int)entry.pid;found=Process32NextW(snapshot,ref entry);}
      return 0;
    } finally{CloseHandle(snapshot);}
  }
  static void Monitor(string[] args) {
    int parent=int.Parse(args[1]);string helper=args[2],directory=args[3],image=args[4],file=args[5],ready=args[6];
    var clock=Stopwatch.StartNew();
    File.WriteAllText(ready,"ready",new UTF8Encoding(false));Row(file,"observer_ready",new {parentPid=parent,deadlineMs=40000,method="unprivileged Toolhelp process snapshot"});
    int pid=0;
    while(clock.ElapsedMilliseconds<40000&&(pid=FindChild(parent))==0)Thread.Sleep(50);
    if(pid==0)throw new Exception("expected-initialize-child-not-observed");
    using(var child=Process.GetProcessById(pid)) {
      IntPtr observed=OpenProcess(0x1000|0x100000,false,pid); // query + synchronize, kept through exit
      if(observed==IntPtr.Zero)throw new Exception("child-exit-query-unavailable");
      try{
        string[] actual=SafeArguments(pid,image,helper,directory);
        Row(file,"actual_initialize_child",new {pid=pid,parentPid=parent,arguments=actual,createdAtUtc=child.StartTime.ToUniversalTime().ToString("o"),observedAfterMs=clock.ElapsedMilliseconds,privateDirectoryExisted=Directory.Exists(directory)});
        bool dirSeen=Directory.Exists(directory),exited=false;
        while(clock.ElapsedMilliseconds<40000) {
          if(WaitForSingleObject(observed,0)==0){uint exitCode;if(!GetExitCodeProcess(observed,out exitCode))throw new Exception("child-exit-code-unavailable");Row(file,"actual_child_exit",new {pid=pid,exitCode=exitCode,observedAfterMs=clock.ElapsedMilliseconds,privateDirectoryExists=Directory.Exists(directory)});exited=true;break;}
          child.Refresh();
          if(!dirSeen&&Directory.Exists(directory)){dirSeen=true;Row(file,"private_directory_first_seen",new {elapsedMs=clock.ElapsedMilliseconds});}
          Row(file,"actual_child_sample",new {pid=pid,elapsedMs=clock.ElapsedMilliseconds,snapshot=Snapshot(child,image),privateDirectoryExists=Directory.Exists(directory)});
          WaitForSingleObject(observed,500);
        }
        if(!exited)Row(file,"observer_deadline",new {pid=pid,processNotTerminatedByObserver=true});
      }finally{CloseHandle(observed);}
    }
  }
  static void Control(string[] args) {
    string image=args[1],helper=args[2],directory=args[3],cwd=args[4],mode=args[5],file=args[6];
    if(!new[]{"closed","open","stages"}.Contains(mode)||Directory.Exists(directory))throw new Exception("fresh-bounded-control-required");
    var info=new ProcessStartInfo(image,String.Join(" ",new[]{"-NoProfile","-NonInteractive","-File",helper,"-Directory",directory,"-Action","initialize","-Name","tunnel-key"}.Select(Quote)));
    info.UseShellExecute=false;info.CreateNoWindow=true;info.WorkingDirectory=cwd;
    info.RedirectStandardInput=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
    using(var child=new Process()) {
      child.StartInfo=info;var clock=Stopwatch.StartNew();child.Start();long stdoutBytes=0,stderrBytes=0;
      Row(file,"direct_control_start",new {pid=child.Id,mode=mode,workingDirectory=cwd,helper=helper,arguments=Argv(Quote(image)+" "+info.Arguments),createNoWindow=true,stdinClosedImmediately=mode!="open"});
      if(mode!="open")child.StandardInput.Close();
      Task output=Task.Factory.StartNew(()=>{byte[] b=new byte[4096];int n;while((n=child.StandardOutput.BaseStream.Read(b,0,b.Length))>0){Interlocked.Add(ref stdoutBytes,n);}Array.Clear(b,0,b.Length);});
      Task error=Task.Factory.StartNew(()=>{byte[] b=new byte[4096];int n;while((n=child.StandardError.BaseStream.Read(b,0,b.Length))>0){Interlocked.Add(ref stderrBytes,n);if(mode=="stages"){
        var text=Encoding.UTF8.GetString(b,0,n);foreach(string line in text.Split('\n'))if(System.Text.RegularExpressions.Regex.IsMatch(line.Trim(),"^LR_STAGE:[a-z_]+:[0-9]+$"))Row(file,"instrumented_control_stage",new {marker=line.Trim(),elapsedMs=clock.ElapsedMilliseconds});
      }}Array.Clear(b,0,b.Length);});
      Row(file,"direct_control_metadata",Snapshot(child,image));
      bool timeout=!child.WaitForExit((int)Math.Max(0,20000-clock.ElapsedMilliseconds));
      if(timeout){child.Kill();child.WaitForExit();} // Only this new owned control helper; never the app or its child.
      Task.WaitAll(new[]{output,error},5000);
      Row(file,"direct_control_exit",new {pid=child.Id,mode=mode,durationMs=clock.ElapsedMilliseconds,exitCode=child.ExitCode,timedOut=timeout,stdoutBytes=stdoutBytes,stderrBytes=stderrBytes,privateDirectoryExists=Directory.Exists(directory),credentialFileCount=Directory.Exists(directory)?Directory.GetFiles(directory,"*.dpapi").Length:0});
    }
  }
  public static int Main(string[] args) {
    try {if(args[0]=="monitor")Monitor(args);else if(args[0]=="control")Control(args);else throw new Exception("unknown-diagnostic-mode");return 0;}
    catch(Exception error){Console.Error.WriteLine("storage-observer-error:"+error.GetType().Name+":"+error.Message);return 1;}
  }
}
