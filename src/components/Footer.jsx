export default function Footer() {
  return (
    <footer className="bg-gray-900 text-gray-300 py-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* Brand */}
          <div>
            <h3 className="text-xl font-bold text-blue-400 mb-3">Navigator</h3>
            <p className="text-sm text-gray-400 mb-2">
              Online resources for the boating community in the Pacific Northwest and beyond.
            </p>
            <p className="text-sm text-gray-500">
              &copy; {new Date().getFullYear()} Navigator PNW LLC. All rights reserved.
            </p>
          </div>

          {/* Services */}
          <div>
            <h3 className="text-lg font-semibold text-white mb-3">Services</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="https://fueldocks.app" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-blue-400 transition-colors">
                  Fuel Docks App
                </a>
              </li>
              <li>
                <a href="https://www.youtube.com/@navigatorpnw" target="_blank" rel="noopener noreferrer" className="text-gray-400 hover:text-blue-400 transition-colors">
                  Navigator Channel
                </a>
              </li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h3 className="text-lg font-semibold text-white mb-3">Contact</h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="mailto:contact@navigatormktg.com" className="text-gray-400 hover:text-blue-400 transition-colors">
                  contact@navigatormktg.com
                </a>
              </li>
              <li>
                <a href="tel:+14258907370" className="text-gray-400 hover:text-blue-400 transition-colors">
                  (425) 890-7370
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  )
}
