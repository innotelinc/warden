require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name = 'WardenBrowser'
  s.version = package['version']
  s.summary = "WARDEN's in-app browser surface"
  s.license = 'MIT'
  s.homepage = 'https://github.com/innotelinc/warden'
  s.author = 'Innotel'
  s.source = { :git => 'https://github.com/innotelinc/warden.git', :tag => s.version.to_s }
  # WARDEN is deployed to the App Store, where a build from a directory that is
  # not under version control is rejected.
  s.source_files = 'Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.swift_version = '5.9'
  s.dependency 'Capacitor'
end
